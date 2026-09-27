#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client as SSH2Client } from 'ssh2';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildSsh3Args,
  buildSsh3Target,
  expandHome,
  loadHostsConfigFile,
  normalizeExitCode,
  resolveConfigPath,
  shellQuoteSingle,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadHostsConfig() {
  const configPath = resolveConfigPath(__dirname, process.env.SSH_HOSTS_CONFIG);
  return loadHostsConfigFile(configPath);
}

function loadInstructions() {
  const instructionsPath = path.join(__dirname, 'docs', 'INSTRUCTIONS.md');
  return fs.readFileSync(instructionsPath, 'utf8');
}

function getHost(hostId) {
  const { hosts } = loadHostsConfig();
  const host = hosts[hostId];
  if (!host) {
    const known = Object.keys(hosts).sort().join(', ');
    throw new McpError(ErrorCode.InvalidParams, `Unknown host_id "${hostId}". Known: ${known}`);
  }
  return host;
}

function loadPrivateKey(privateKeyPath) {
  const keyPath = expandHome(privateKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key not found: ${keyPath}`);
  }
  return fs.readFileSync(keyPath, 'utf8');
}

function connectDirect({ host, user, port, privateKeyPath, timeoutMs }) {
  const privateKey = loadPrivateKey(privateKeyPath);

  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        reject(new Error(`SSH timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    conn
      .on('ready', () => {
        clearTimeout(timer);
        settled = true;
        resolve(conn);
      })
      .on('error', (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      })
      .connect({
        host,
        port: port ?? 22,
        username: user,
        privateKey,
        readyTimeout: Math.min(timeoutMs, 30000),
      });
  });
}

function execDirect({ host, user, port, privateKeyPath, command, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    connectDirect({ host, user, port, privateKeyPath, timeoutMs })
      .then((conn) => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            settled = true;
            conn.end();
            reject(err);
            return;
          }

          let stdout = '';
          let stderr = '';
          stream.on('data', (chunk) => {
            stdout += chunk.toString();
          });
          stream.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          stream.on('close', (code) => {
            clearTimeout(timer);
            settled = true;
            conn.end();
            resolve({ stdout, stderr, exitCode: code ?? 0 });
          });
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
  });
}

/** Max bytes embedded in remote `echo … | base64 -d` (ARG_MAX safety). */
const BASE64_EXEC_MAX_BYTES = 48_000;

/**
 * Write remote file via SFTP (preferred). Falls back to base64 exec for hosts
 * without sftp-server (some OpenWrt images).
 */
async function writeDirectFile({
  host,
  user,
  port,
  privateKeyPath,
  filePath,
  content,
  mode = 'rewrite',
  timeoutMs,
}) {
  const body = Buffer.from(content ?? '', 'utf8');
  const flags = mode === 'append' ? 'a' : 'w';

  try {
    const conn = await connectDirect({ host, user, port, privateKeyPath, timeoutMs });
    try {
      const sftp = await new Promise((resolve, reject) => {
        conn.sftp((err, sftpClient) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(sftpClient);
        });
      });
      await new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(filePath, { flags, encoding: null });
        stream.on('error', reject);
        stream.on('close', resolve);
        stream.end(body);
      });
      const stat = await new Promise((resolve, reject) => {
        sftp.stat(filePath, (err, stats) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stats);
        });
      });
      const expectedSize =
        mode === 'append' ? undefined : body.length;
      if (expectedSize !== undefined && Number(stat.size) !== expectedSize) {
        throw new Error(
          `SFTP write size mismatch: got ${stat.size}, expected ${expectedSize}`,
        );
      }
      return {
        stdout: `wrote ${stat.size} bytes via sftp to ${filePath}`,
        stderr: '',
        exitCode: 0,
        method: 'sftp',
        bytes: Number(stat.size),
      };
    } finally {
      conn.end();
    }
  } catch (sftpErr) {
    if (body.length > BASE64_EXEC_MAX_BYTES) {
      throw new Error(
        `SFTP write failed (${sftpErr instanceof Error ? sftpErr.message : sftpErr}); ` +
          `content ${body.length} bytes exceeds base64-exec fallback limit ${BASE64_EXEC_MAX_BYTES}`,
      );
    }
    const b64 = body.toString('base64');
    const redirect = mode === 'append' ? '>>' : '>';
    const quotedPath = shellQuoteSingle(filePath);
    const cmd =
      `echo ${shellQuoteSingle(b64)} | base64 -d ${redirect} ${quotedPath} && ` +
      `wc -c < ${quotedPath}`;
    const result = await execDirect({
      host,
      user,
      port,
      privateKeyPath,
      command: cmd,
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(
        `base64-exec write failed (exit ${result.exitCode})` +
          (detail ? `: ${detail}` : '') +
          `; sftp error was: ${sftpErr instanceof Error ? sftpErr.message : sftpErr}`,
      );
    }
    const written = Number.parseInt(String(result.stdout).trim(), 10);
    if (mode !== 'append' && Number.isFinite(written) && written !== body.length) {
      throw new Error(
        `base64-exec write size mismatch: got ${written}, expected ${body.length}`,
      );
    }
    return {
      stdout: `wrote ${Number.isFinite(written) ? written : body.length} bytes via base64-exec to ${filePath}`,
      stderr: result.stderr,
      exitCode: 0,
      method: 'base64-exec',
      bytes: Number.isFinite(written) ? written : body.length,
    };
  }
}

// Write remote file over the ssh3 transport (no SFTP in ssh3): embed content
// as base64 in a shell command, verify written size via `wc -c`.
async function writeSsh3File(profile, { filePath, content, mode = 'rewrite', timeoutMs }) {
  const body = Buffer.from(content ?? '', 'utf8');
  if (body.length > BASE64_EXEC_MAX_BYTES) {
    throw new Error(
      `ssh3 write: content ${body.length} bytes exceeds base64-exec limit ${BASE64_EXEC_MAX_BYTES}`,
    );
  }
  const b64 = body.toString('base64');
  const redirect = mode === 'append' ? '>>' : '>';
  const quotedPath = shellQuoteSingle(filePath);
  const cmd =
    `echo ${shellQuoteSingle(b64)} | base64 -d ${redirect} ${quotedPath} && ` +
    `wc -c < ${quotedPath}`;
  const result = await execSsh3(profile, cmd, timeoutMs);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `ssh3 write failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
    );
  }
  const written = Number.parseInt(String(result.stdout).trim(), 10);
  if (mode !== 'append' && Number.isFinite(written) && written !== body.length) {
    throw new Error(`ssh3 write size mismatch: got ${written}, expected ${body.length}`);
  }
  return {
    stdout: `wrote ${Number.isFinite(written) ? written : body.length} bytes via ssh3-exec to ${filePath}`,
    stderr: result.stderr,
    exitCode: 0,
    method: 'ssh3-exec',
    bytes: Number.isFinite(written) ? written : body.length,
  };
}

function execWsl({ wslHost, command, timeoutMs }) {
  const remoteCmd = shellQuoteSingle(command);
  const bashScript = `ssh -o ConnectTimeout=30 -o BatchMode=yes ${wslHost} ${remoteCmd}`;
  const args = ['bash', '-lc', bashScript];

  return new Promise((resolve, reject) => {
    const child = spawn('wsl', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`WSL SSH timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      }
    });
  });
}

function execSsh3(profile, command, timeoutMs) {
  const clientPath = profile.clientPath || 'ssh3-client';
  const args = buildSsh3Args(profile, command);
  // client logs (zerolog) go to stderr; keep them out of exec results
  const env = { ...process.env, SSH3_LOG_LEVEL: profile.logLevel ?? 'error' };

  return new Promise((resolve, reject) => {
    const child = spawn(clientPath, args, { windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`ssh3 timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: normalizeExitCode(code) ?? 1 });
      }
    });
  });
}

async function runOnHost(hostId, command, timeoutMs = 120000) {
  const profile = getHost(hostId);

  if (profile.transport === 'wsl') {
    return execWsl({ wslHost: profile.wslHost, command, timeoutMs });
  }

  if (profile.transport === 'ssh3') {
    return execSsh3(profile, command, timeoutMs);
  }

  if (profile.transport === 'direct' || !profile.transport) {
    return execDirect({
      host: profile.host,
      user: profile.user,
      port: profile.port,
      privateKeyPath: profile.privateKeyPath,
      command,
      timeoutMs,
    });
  }

  throw new McpError(ErrorCode.InvalidParams, `Unsupported transport for ${hostId}: ${profile.transport}`);
}

function formatExecResult(hostId, result) {
  const ok = result.exitCode === 0;
  return JSON.stringify(
    {
      success: ok,
      host_id: hostId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    null,
    2,
  );
}

function ssh3TargetOrNull(profile) {
  if (profile.transport !== 'ssh3') {
    return null;
  }
  try {
    return buildSsh3Target(profile);
  } catch (err) {
    return `invalid: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const TOOLS = [
  {
    name: 'ssh_list_hosts',
    description: 'List configured SSH hosts (use host_id with ssh_exec)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ssh_exec',
    description: 'Execute a command on a configured host by host_id',
    inputSchema: {
      type: 'object',
      properties: {
        host_id: {
          type: 'string',
          description: 'Host id from ssh_list_hosts (e.g. prod-openwrt, dslab-ml)',
        },
        command: {
          type: 'string',
          description: 'Remote command (bash on Linux; RouterOS on MikroTik hosts)',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default 120000)',
          default: 120000,
        },
      },
      required: ['host_id', 'command'],
    },
  },
  {
    name: 'ssh_read_file',
    description: 'Read a remote file via cat (direct and ssh3 hosts; not wsl)',
    inputSchema: {
      type: 'object',
      properties: {
        host_id: { type: 'string' },
        filePath: { type: 'string' },
        timeoutMs: { type: 'number', default: 120000 },
      },
      required: ['host_id', 'filePath'],
    },
  },
  {
    name: 'ssh_write_file',
    description:
      'Write remote file: SFTP on direct hosts, base64-exec on ssh3 (48 KB limit). Param is filePath (not path).',
    inputSchema: {
      type: 'object',
      properties: {
        host_id: { type: 'string' },
        filePath: {
          type: 'string',
          description: 'Absolute remote path (required name: filePath, not path)',
        },
        content: { type: 'string', description: 'File content (UTF-8)' },
        mode: {
          type: 'string',
          enum: ['rewrite', 'append'],
          default: 'rewrite',
        },
        timeoutMs: { type: 'number', default: 120000 },
      },
      required: ['host_id', 'filePath', 'content'],
    },
  },
];

const server = new Server(
  { name: 'ssh-hosts-mcp', version: '1.1.1' },
  { capabilities: { tools: {} }, instructions: loadInstructions() },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'ssh_list_hosts') {
      const { configPath, hosts } = loadHostsConfig();
      const list = Object.entries(hosts).map(([id, h]) => ({
        host_id: id,
        label: h.label ?? id,
        transport: h.transport ?? 'direct',
        host: h.host ?? h.wslHost ?? null,
        target: ssh3TargetOrNull(h),
        user: h.user ?? null,
        shell: h.shell ?? 'bash',
        notes: h.notes ?? null,
      }));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ config: configPath, hosts: list }, null, 2),
          },
        ],
      };
    }

    if (name === 'ssh_exec') {
      const { host_id, command, timeoutMs = 120000 } = args ?? {};
      if (!host_id || !command) {
        throw new McpError(ErrorCode.InvalidParams, 'host_id and command are required');
      }
      const result = await runOnHost(host_id, command, timeoutMs);
      return { content: [{ type: 'text', text: formatExecResult(host_id, result) }] };
    }

    if (name === 'ssh_read_file') {
      const { host_id, filePath, timeoutMs = 120000 } = args ?? {};
      if (!host_id || !filePath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'host_id and filePath are required (filePath, not path)',
        );
      }
      const profile = getHost(host_id);
      if (profile.transport === 'wsl') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `${host_id}: file read via MCP not supported (WSL proxy). Use ssh_exec with cat or tar|ssh from WSL.`,
        );
      }
      const cmd = `cat ${shellQuoteSingle(filePath)}`;
      const result = await runOnHost(host_id, cmd, timeoutMs);
      return { content: [{ type: 'text', text: formatExecResult(host_id, result) }] };
    }

    if (name === 'ssh_write_file') {
      const raw = args ?? {};
      const host_id = raw.host_id;
      const filePath = raw.filePath ?? raw.path;
      const content = raw.content;
      const mode = raw.mode === 'append' ? 'append' : 'rewrite';
      const timeoutMs = raw.timeoutMs ?? 120000;

      if (!host_id) {
        throw new McpError(ErrorCode.InvalidParams, 'host_id is required');
      }
      if (content === undefined || content === null) {
        throw new McpError(ErrorCode.InvalidParams, 'content is required');
      }
      if (!filePath || typeof filePath !== 'string') {
        const hint =
          raw.path !== undefined && raw.filePath === undefined
            ? ' received "path" — use filePath'
            : '';
        throw new McpError(
          ErrorCode.InvalidParams,
          `filePath is required (absolute remote path)${hint}`,
        );
      }
      if (filePath === 'undefined' || filePath === 'null') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `refusing to write to literal path "${filePath}" (likely missing filePath arg)`,
        );
      }

      const profile = getHost(host_id);
      if (profile.transport === 'wsl') {
        throw new McpError(
          ErrorCode.InvalidParams,
          `${host_id}: file write via MCP not supported. Use tar|ssh from WSL.`,
        );
      }

      const writeParams = {
        filePath,
        content: String(content),
        mode,
        timeoutMs,
      };
      const result =
        profile.transport === 'ssh3'
          ? await writeSsh3File(profile, writeParams)
          : await writeDirectFile({ ...profile, ...writeParams });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                host_id,
                exitCode: 0,
                method: result.method,
                bytes: result.bytes,
                filePath,
                stdout: result.stdout,
                stderr: result.stderr,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (err) {
    if (err instanceof McpError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }, null, 2) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

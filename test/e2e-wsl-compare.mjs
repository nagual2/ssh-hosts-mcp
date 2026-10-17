#!/usr/bin/env node
// E2E comparison: WSL access via the ssh3 MCP transport (channel A) vs a
// direct wsl.exe call (channel B). Channel A spawns the real MCP stdio server
// (index.mjs) so the measured path is exactly what an agent uses.
// Requires the live wsl-ssh3 host from hosts.local.json.
// Env: WSL_COMPARE_HOST (default wsl-ssh3), WSL_COMPARE_N (default 5),
//      WSL_COMPARE_TERMINATE=1 — terminate the WSL distro before the idle test
//      (deterministic cold-wake check; kills anything running in the distro).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'index.mjs');
const HOST = process.env.WSL_COMPARE_HOST ?? 'wsl-ssh3';
const N = Math.max(1, Number(process.env.WSL_COMPARE_N ?? 5));
const RESULTS = [];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function line(buf) {
  const idx = buf.indexOf('\n');
  if (idx === -1) return null;
  return { line: buf.slice(0, idx), rest: buf.slice(idx + 1) };
}

// Persistent MCP stdio session against the project server (resolves
// hosts.local.json with the wsl-ssh3 profile).
function startMcp(serverPath) {
  const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const part = line(buf);
      if (!part) break;
      buf = part.rest;
      try {
        const msg = JSON.parse(part.line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON stdout noise
      }
    }
  });
  const call = (method, params, timeoutMs = 150000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(msg.error.message ?? 'MCP error'));
          return;
        }
        resolve(msg.result);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n',
      );
    });
  const init = async () => {
    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wsl-compare', version: '0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  };
  const callTool = async (name, args, timeoutMs) => {
    const result = await call('tools/call', { name, arguments: args }, timeoutMs);
    return JSON.parse(result.content[0].text);
  };
  return { call, init, callTool, kill: () => child.kill() };
}

function wslExec(command, timeoutMs = 120000) {
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['bash', '-lc', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\nTIMEOUT`.trim(), ms: performance.now() - start });
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message, ms: performance.now() - start });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - start });
    });
  });
}

async function mcpExec(mcp, command, timeoutMs = 120000) {
  const start = performance.now();
  try {
    const r = await mcp.callTool('ssh_exec', { host_id: HOST, command, timeoutMs }, timeoutMs + 20000);
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - start };
  } catch (err) {
    return { code: null, stdout: '', stderr: err.message, ms: performance.now() - start };
  }
}

function record(name, a, b, ok, note = '') {
  RESULTS.push({ name, ok, a, b, note });
  const fmt = (x) => (x == null ? 'n/a' : `${Math.round(x)}ms`);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}  ssh3: ${fmt(a)}  wsl.exe: ${fmt(b)}${note ? `  (${note})` : ''}`,
  );
}

const mcp = startMcp(SERVER);
let failures = 0;
try {
  await mcp.init();

  // 1. exec latency, N runs each
  {
    // warmup: wake the distro (channel B) and prime the ssh3 path so the
    // latency numbers are not polluted by the cold-start case (test 5 covers it)
    await wslExec('echo warm');
    await mcpExec(mcp, 'echo warm');
    const a = [];
    const b = [];
    for (let i = 0; i < N; i++) {
      const ra = await mcpExec(mcp, 'echo ok');
      const rb = await wslExec('echo ok');
      if (ra.code === 0 && ra.stdout.includes('ok')) a.push(ra.ms);
      if (rb.code === 0 && rb.stdout.includes('ok')) b.push(rb.ms);
    }
    const ok = a.length === N && b.length === N;
    if (!ok) failures++;
    record(`echo x${N} (median)`, median(a), median(b), ok, `min/max A: ${Math.round(Math.min(...a))}/${Math.round(Math.max(...a))}ms`);
  }

  // 2. exit code propagation
  {
    const ra = await mcpExec(mcp, 'sh -c "exit 42"');
    const rb = await wslExec('sh -c "exit 42"');
    const ok = ra.code === 42 && rb.code === 42;
    if (!ok) failures++;
    record('exit 42 propagates', ra.ms, rb.ms, ok, `A:${ra.code} B:${rb.code}`);
  }

  // 3. 4 KB file write/read round trip
  {
    const payload = 'x'.repeat(4096);
    const w = await mcp.callTool('ssh_write_file', {
      host_id: HOST,
      filePath: '/tmp/ssh3-bench-4k.bin',
      content: payload,
    });
    const r = await mcp.callTool('ssh_read_file', {
      host_id: HOST,
      filePath: '/tmp/ssh3-bench-4k.bin',
      limit: 8192,
    });
    const ok = w.bytes === 4096 && r.content === payload;
    if (!ok) failures++;
    record('4KB write+read (ssh3 base64-exec)', null, null, ok, `bytes:${w.bytes} readLen:${r.content.length}`);
    await mcpExec(mcp, 'rm -f /tmp/ssh3-bench-4k.bin');
  }

  // 4. 1 MB output volume
  {
    const ra = await mcpExec(mcp, 'head -c 1000000 /dev/zero | wc -c', 60000);
    const rb = await wslExec('head -c 1000000 /dev/zero | wc -c');
    const ok = ra.stdout.trim() === '1000000' && rb.stdout.trim() === '1000000';
    if (!ok) failures++;
    record('1MB output volume', ra.ms, rb.ms, ok, `A:${ra.stdout.trim()} B:${rb.stdout.trim()}`);
  }

  // 5. idle survival (WSL 3.0.1 kills an idle distro in ~20-30s; wsl.exe wakes
  //    it, inbound QUIC stays dead). WSL_COMPARE_TERMINATE=1 forces it.
  {
    if (process.env.WSL_COMPARE_TERMINATE === '1') {
      const list = await new Promise((resolve) => {
        const c = spawn('wsl.exe', ['-l', '-q']);
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('close', () => resolve(out));
      });
      const text = list.includes('\u0000') ? list.toString('utf16le') : list;
      const distro = text.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (distro) {
        await new Promise((r) => spawn('wsl.exe', ['--terminate', distro]).on('close', r));
        console.log(`terminated distro "${distro}" for the cold-wake check`);
      }
    } else {
      console.log('idling 35s (set WSL_COMPARE_TERMINATE=1 for a deterministic cold-wake test)...');
      await sleep(35000);
    }
    const ra = await mcpExec(mcp, 'echo alive', 15000);
    const rb = await wslExec('echo alive', 30000);
    const aAlive = ra.code === 0 && ra.stdout.includes('alive');
    const bAlive = rb.code === 0 && rb.stdout.includes('alive');
    const ok = bAlive; // channel B waking the distro is the expected behavior
    if (!ok) failures++;
    record(
      'idle wake: ssh3 vs wsl.exe',
      ra.ms,
      rb.ms,
      ok,
      `ssh3 ${aAlive ? 'survived' : 'dead (expected after idle shutdown)'} / wsl ${bAlive ? 'woke' : 'dead'}`,
    );
  }

  // 6. ssh_server_status over ssh3
  {
    try {
      const s = await mcp.callTool('ssh_server_status', { host_id: HOST, timeoutMs: 60000 });
      const ok = s.success && s.stdout.includes('== uptime ==') && s.stdout.includes('== disk ==');
      if (!ok) failures++;
      record('ssh_server_status over ssh3', null, null, ok);
    } catch (err) {
      failures++;
      record('ssh_server_status over ssh3', null, null, false, err.message);
    }
  }
} catch (err) {
  console.log(`ABORT: ${err.message}`);
  failures++;
} finally {
  mcp.kill();
}

const passed = RESULTS.length - failures;
console.log(`\n${passed}/${RESULTS.length} checks passed; failures: ${failures}`);
process.exit(failures > 0 ? 1 : 0);

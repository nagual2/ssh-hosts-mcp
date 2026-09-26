// Pure helpers for ssh-hosts-mcp: config loading, quoting and ssh3 client
// argument building. No side effects beyond reading config files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(filePath, homeDir = os.homedir()) {
  if (!filePath) {
    return filePath;
  }
  if (filePath.startsWith('~/')) {
    return path.join(homeDir, filePath.slice(2));
  }
  return filePath;
}

export function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Go clients exit with the remote status; on win32 a -1 from the client
// surfaces as unsigned 0xFFFFFFFF. Map unsigned 32-bit codes back to signed.
export function normalizeExitCode(code) {
  if (code === null || code === undefined) {
    return null;
  }
  const n = Number(code);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n >= 2 ** 31 ? n - 2 ** 32 : n;
}

function requireField(profile, name) {
  const value = profile[name];
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    throw new Error(`ssh3 host profile requires a valid "${name}"`);
  }
  return value;
}

export function buildSsh3Target(profile) {
  const user = requireField(profile, 'user');
  const host = requireField(profile, 'host');
  const port = profile.port ?? 443;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ssh3 host profile requires a valid "port", got: ${profile.port}`);
  }
  let urlPath = profile.urlPath ?? '/';
  if (urlPath.length === 0) {
    urlPath = '/';
  }
  if (!urlPath.startsWith('/')) {
    urlPath = `/${urlPath}`;
  }
  return `${user}@${host}:${port}${urlPath}`;
}

// ssh3 client (Go flag package) requires all flags BEFORE the positional
// user@host:port/urlPath argument (TRAP go-flags-after-positional).
export function buildSsh3Args(profile, command, homeDir = os.homedir()) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('ssh3 command must be a non-empty string');
  }
  const args = [];
  if (profile.privateKeyPath) {
    // fork nagual2/ssh3 v0.1.8: the key flag is "-privkey" (plugin privkey_auth)
    args.push('-privkey', expandHome(profile.privateKeyPath, homeDir));
  }
  if (profile.insecure) {
    args.push('-insecure');
  }
  args.push(buildSsh3Target(profile));
  args.push(command);
  return args;
}

export function loadHostsConfigFile(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.hosts || typeof parsed.hosts !== 'object') {
    throw new Error(`Invalid hosts config: ${configPath}`);
  }
  return { configPath, hosts: parsed.hosts };
}

// Precedence: SSH_HOSTS_CONFIG env override > hosts.local.json (real
// addresses, gitignored) > hosts.json (anonymized template).
export function resolveConfigPath(dir, envOverride) {
  if (envOverride) {
    return envOverride;
  }
  const localPath = path.join(dir, 'hosts.local.json');
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  return path.join(dir, 'hosts.json');
}

// Pure helpers for ssh-hosts-mcp: config loading, quoting and ssh3 client
// argument building. No side effects beyond reading config files.

import crypto from 'node:crypto';
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

// ssh2 hostVerifier sync contract: return true/false, never throw (a thrown
// error escapes the kex handshake path with no catch and kills the process).
// Accepts trustedHostKey in three forms: plain sha256-base64 with padding,
// unpadded base64 (ssh-keygen prints fingerprints without "="), and the
// "SHA256:<unpadded>" prefixed form.
export function makeHostVerifier(expectedHash) {
  if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
    return undefined;
  }
  const expected = expectedHash.replace(/^SHA256:/i, '').replace(/=+$/, '');
  return (key) => {
    const actual = crypto
      .createHash('sha256')
      .update(key)
      .digest('base64')
      .replace(/=+$/, '');
    return actual === expected;
  };
}

// ---------- WSL idle wake (variant 3) ----------

// WSL 3.x shuts an idle distro down after ~30s (LxssManager counts only
// client-side wsl.exe sessions, not processes inside the distro), which kills
// inbound QUIC to ssh3 servers inside it. Threshold stays below the observed
// idle window so the gate fires before the distro dies.
export const WAKE_IDLE_THRESHOLD_MS = 25_000;

/**
 * True when the ssh3 call should wake the target distro first: only for
 * profiles declaring "wake": "wsl"; unknown distro state (no successful call
 * yet) wakes; idle longer than the threshold wakes.
 */
export function shouldWake(profile, now, lastSuccess) {
  if (profile?.wake !== 'wsl') {
    return false;
  }
  if (typeof lastSuccess !== 'number') {
    return true;
  }
  return now - lastSuccess >= WAKE_IDLE_THRESHOLD_MS;
}

function requireField(profile, name) {
  const value = profile[name];
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    throw new Error(`ssh3 host profile requires a valid "${name}"`);
  }
  return value;
}

// ---------- command policy (plan part 1, item 4) ----------

// Hard denylist applied before any configured policy; allow-lists can never
// re-enable these. Kept narrow to avoid false positives on legit operations.
const NEVER_ALLOWED = [
  { rule: 'rm -rf /', re: /^\s*rm\s+(?:-[\w-]+\s+)*-?[a-z]*\s*\/(?=\s|$)/ },
  { rule: 'mkfs', re: /\bmkfs/ },
  { rule: 'dd of=/dev/*', re: /\bdd\s[^\n]*\bof=\/dev\// },
  { rule: 'curl|sh', re: /\b(cu?rl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|fi|k)?sh\b/ },
  { rule: 'fork bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;?\s*:/ },
  { rule: 'chmod 777 /', re: /\bchmod\b[^\n]*\s\/(?:\s|$)/ },
  { rule: 'overwrite block device', re: />\s*\/dev\/(?:sd[a-z]+|mmcblk\d+|nvme\d+n\d+)\s*$/ },
];

// In whitelist mode these metacharacters would let a whitelisted command
// prefix smuggle arbitrary commands; RouterOS pipes are legit syntax there.
const CHAINING_RE = /[;&|<>`]|\$\(|\n/;

function compileRegexList(list, name) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((src) => {
    try {
      return new RegExp(src);
    } catch (err) {
      throw new Error(`policy.${name}: invalid regex ${JSON.stringify(src)}: ${err.message}`);
    }
  });
}

/**
 * Pure policy check for ssh_exec. Returns { allowed: true } or
 * { allowed: false, reason, rule }. deny beats allow; fail closed in
 * whitelist mode; never-allowed applies regardless of configuration.
 */
export function checkCommandPolicy(policy, command, shell = 'bash') {
  for (const { rule, re } of NEVER_ALLOWED) {
    if (re.test(command)) {
      return { allowed: false, rule, reason: `command blocked by never-allowed rule "${rule}"` };
    }
  }
  if (!policy || typeof policy !== 'object') {
    return { allowed: true };
  }
  const deny = compileRegexList(policy.deny, 'deny');
  for (const re of deny) {
    if (re.test(command)) {
      return { allowed: false, rule: String(re), reason: `command blocked by policy.deny` };
    }
  }
  const allow = compileRegexList(policy.allow, 'allow');
  if (allow.length > 0) {
    const permitted = allow.some((re) => re.test(command));
    if (!permitted) {
      return { allowed: false, rule: 'allow', reason: 'command not matched by policy.allow whitelist' };
    }
    // Whitelist mode: block chaining/redirect metacharacters so a whitelisted
    // prefix cannot smuggle arbitrary commands. RouterOS pipes are legit.
    if (shell !== 'routeros' && CHAINING_RE.test(command)) {
      return {
        allowed: false,
        rule: 'allow-chaining',
        reason: 'whitelisted command contains shell chaining metacharacters',
      };
    }
  }
  return { allowed: true };
}

// ---------- path confinement (plan part 1, item 5) ----------

/**
 * Confinement check for ssh_read_file ('read') / ssh_write_file ('write').
 * Paths must be absolute POSIX without ".." segments; allowed when the path
 * falls under one of profile.allowedPaths[mode] prefixes. Unconstrained when
 * the list for the mode is absent.
 */
export function checkPathAllowed(filePath, mode, profile = {}) {
  if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
    return { allowed: false, reason: 'remote path must be absolute POSIX (start with /)' };
  }
  if (filePath.split('/').includes('..')) {
    return { allowed: false, reason: 'remote path must not contain ".." segments' };
  }
  const allowed = profile?.allowedPaths?.[mode];
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return { allowed: true };
  }
  for (const prefix of allowed) {
    const p = String(prefix);
    const bounded = p.endsWith('/') ? p : `${p}/`;
    if (filePath === p || filePath.startsWith(bounded)) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `remote path is outside allowedPaths.${mode}` };
}

// ---------- exec output limit (plan part 1, item 2) ----------

/**
 * Truncate stdout to maxBytes (Buffer-based, so multibyte chars are cut on
 * byte boundaries). Returns { text, truncated }; no limit -> unchanged.
 */
export function truncateOutput(text, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    return { text, truncated: false };
  }
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: `${buf.subarray(0, maxBytes).toString('utf8')}\n[output truncated at ${maxBytes} bytes (maxOutputBytes)]`,
    truncated: true,
  };
}

// ---------- read pagination (plan part 1, item 6) ----------

/**
 * Byte-range remote read command: `tail -c +N | head -c L` (busybox-safe).
 * offset is 0-based; limit in bytes. Path is shell-quoted.
 */
export function buildReadCommand(filePath, offset = 0, limit = 65536) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`offset must be a non-negative integer, got: ${offset}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit must be a positive integer, got: ${limit}`);
  }
  const quoted = shellQuoteSingle(filePath);
  if (offset === 0) {
    return `head -c ${limit} ${quoted}`;
  }
  return `tail -c +${offset + 1} ${quoted} | head -c ${limit}`;
}

// ---------- server status (plan part 1, item 7) ----------

/**
 * One-shot status command. bash variant uses /proc + busybox tools present on
 * OpenWrt; RouterOS gets the single resource print (uptime/cpu/mem/disk).
 */
export function buildServerStatusCommand(shell = 'bash') {
  if (shell === 'routeros') {
    return '/system resource print';
  }
  return [
    'echo "== uptime =="; cat /proc/uptime;',
    'echo "== load =="; cat /proc/loadavg;',
    'echo "== mem =="; free 2>/dev/null || head -n 5 /proc/meminfo;',
    'echo "== disk =="; df -h / 2>/dev/null || df -h;',
  ].join(' ');
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
  const hosts = parsed.hosts;
  // Optional top-level "defaults" is shallow-merged into every host profile;
  // per-host values win wholesale (nested objects are not deep-merged).
  if (parsed.defaults && typeof parsed.defaults === 'object') {
    for (const id of Object.keys(hosts)) {
      hosts[id] = { ...parsed.defaults, ...hosts[id] };
    }
  }
  return { configPath, hosts };
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

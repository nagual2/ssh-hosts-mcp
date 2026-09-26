import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const joinHome = (home, rel) => join(home, rel);
import {
  expandHome,
  shellQuoteSingle,
  normalizeExitCode,
  buildSsh3Target,
  buildSsh3Args,
  loadHostsConfigFile,
  resolveConfigPath,
} from '../lib.mjs';

const FAKE_HOME = 'C:/Users/tester';

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

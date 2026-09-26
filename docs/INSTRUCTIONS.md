# SSH Hosts MCP — server instructions

Unified SSH/SSH3 access for infrastructure hosts. Use MCP tools instead of raw `ssh`/`scp` in the shell when the target host is in the registry.

## Workflow

1. Call **`ssh_list_hosts`** if you are unsure of `host_id` or transport type.
2. Run commands with **`ssh_exec`** (`host_id` + `command`).
3. Use **`ssh_read_file`** / **`ssh_write_file`** only on **`direct`** and **`ssh3`** hosts (not `dslab-ml`).

Always pass `host_id` from the registry — never embed IP, user, or key paths in tool arguments.

## Tools

| Tool | Purpose |
|------|---------|
| `ssh_list_hosts` | List configured hosts and metadata (`target` = ssh3 `user@host:port/urlPath`) |
| `ssh_exec` | Run a remote command |
| `ssh_read_file` | Read file via `cat` (direct and ssh3 hosts) |
| `ssh_write_file` | Write file: **SFTP** on `direct` hosts (base64-exec fallback), **base64-exec** on `ssh3` hosts (48 KB limit) |

**Params:** `host_id`, **`filePath`** (not `path`), `content`. Missing `filePath` used to write to a literal file named `undefined` — server now rejects that.

**OpenWrt:** SFTP needs `openssh-sftp-server` (or dropbear sftp). Fallback `base64 -d` still needs `coreutils-base64` (busybox has no base64 applet).

### `ssh_exec` response

JSON: `success`, `host_id`, `exitCode`, `stdout`, `stderr`. Check `success` / `exitCode` before assuming the command worked.

Default timeout: **120000 ms**. Lower for quick probes (`uname`, `ping`).

## Host registry

Config file precedence: env `SSH_HOSTS_CONFIG` → `hosts.local.json` (real addresses, gitignored) → `hosts.json` (anonymized template, safe to publish).

| host_id | IP / target | Shell | transport | Notes |
|---------|-------------|-------|-----------|-------|
| `prod-openwrt` | 192.0.2.1 | bash | direct | Production OpenWrt |
| `openwrt-dev` | 192.0.2.56 | bash | direct | Hyper-V VM; often powered off |
| `mikrotik-dev` | 192.0.2.45 | **routeros** | direct | CHR VM; often powered off |
| `minisforum` | 192.0.2.125 | bash | direct | Linux box |
| `minisforum-ssh3` | `user@minisforum.example.lan:443/ssh3-term` | bash | **ssh3** | Same box over ssh3 (UDP 443, key-only) |
| `wsl-ssh3` | `user@wsl.example.lan:443/ssh3-term` | bash | **ssh3** | WSL ssh3-server, dual-stack IPv4+IPv6 |
| `dslab-ml` | WSL alias | bash | **wsl** | JWT proxy ~15 min; refresh auth via your own reconnect helper |

Full host details (serial console, MACs, keys): Cursor rule `@ssh-servers` / `.cursor/rules/ssh-servers.mdc`.

## Shell types

### bash (OpenWrt, Linux)

Normal shell commands. OpenWrt uses **dropbear** — for manual CLI `scp` from terminal use **`-O`** (legacy scp). MCP file tools handle transfer without `-O`.

### routeros (MikroTik)

RouterOS CLI, **not** bash. Examples:

- `/system identity print`
- `/interface print`
- `/ip address print`

Do not use `&&`, pipes, or Linux paths unless RouterOS supports them.

## Transport

### `direct`

Node `ssh2` from Windows with `privateKeyPath` from config (`~` expanded).

- `ssh_exec`, `ssh_read_file`, `ssh_write_file` supported.

### `ssh3`

Spawns the ssh3 client (`clientPath`, default `ssh3-client` on PATH): `ssh3 [-privkey key] [-insecure] user@host:port/urlPath "command"`.

- `ssh_exec`, `ssh_read_file`, `ssh_write_file` supported (no SFTP: writes go through base64-exec, ≤48 KB).
- Remote exit code is propagated (`client.ExitStatus`). Client logs go to stderr; `logLevel` (default `error`) quiets runtime logs, but the client's first plugin-registration info lines always appear in stderr (emitted before logger setup — upstream candidate).
- Server cert must be pinned in `~/.ssh3/known_hosts` (TOFU) or set `"insecure": true` (dev only).
- Requires ssh3 server ≥ 0.1.8 (fork `nagual2/ssh3`); QUIC over UDP, so firewalls must pass UDP to the server port.
- Flags always go **before** the positional target (Go `flag.Parse` stops at the first positional).

### `wsl` (`dslab-ml`)

Runs `wsl bash -lc 'ssh -o BatchMode=yes <wslHost> <command>'`.

- Only **`ssh_exec`** is supported.
- **`ssh_read_file`** / **`ssh_write_file`** will error — use `ssh_exec` with `cat`, or `tar|ssh` from WSL manually.
- SCP through the proxy does not work; use `tar|ssh` or `ssh cat`.

## Anti-patterns

| Wrong | Right |
|-------|-------|
| `2>/dev/null` on remote commands | Show full stderr |
| Guessing IP/user/key in `ssh_exec` | Use `host_id` from registry |
| bash on `mikrotik-*` | RouterOS syntax |
| `ssh_read_file` on `dslab-ml` | `ssh_exec` + `cat` or WSL `tar|ssh` |
| Ignoring `exitCode != 0` | Read `stderr`, adjust command |
| `ssh_write_file` arg `path=` | **`filePath=`** (schema name); alias `path` accepted but prefer `filePath` |
| Assume write OK without verify | Check `success`, `bytes`, then `ssh_exec`/`ssh_read_file` |
| ssh3 host without pinned cert | Pin TOFU in `~/.ssh3/known_hosts` first (non-TTY fails closed) |

## Adding a host

Edit `hosts.local.json` (real addresses) or `hosts.json` (anonymized template) under `"hosts"`:

```json
"my-host": {
  "label": "Human label",
  "transport": "direct",
  "host": "192.0.2.x",
  "user": "root",
  "port": 22,
  "privateKeyPath": "~/.ssh/id_ed25519_example",
  "shell": "bash",
  "notes": "optional"
}
```

SSH3 host (client spawns `clientPath`, cert pinned via TOFU):

```json
"my-ssh3-host": {
  "label": "Human label",
  "transport": "ssh3",
  "host": "server.example.lan",
  "port": 443,
  "urlPath": "/ssh3-term",
  "user": "user",
  "privateKeyPath": "~/.ssh/id_ed25519_example",
  "clientPath": "ssh3-client",
  "logLevel": "error",
  "notes": "optional"
}
```

WSL-proxied SSH:

```json
"dslab-ml": {
  "transport": "wsl",
  "wslHost": "alias-from-wsl-ssh-config",
  "user": "coder",
  "notes": "..."
}
```

Reload the MCP host (or Reload Window) after changing config or server code.

## Tests

```
npm test        # node --test test/lib.test.mjs (pure helpers, no network)
```

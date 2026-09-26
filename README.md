# ssh-hosts-mcp

[English](README.md) | [Русский](README.ru.md) | [Deutsch](README.de.md)

Unified SSH MCP server with a host registry — one `host_id` per call instead of IPs, users and key paths.

## Overview

ssh-hosts-mcp is a [Model Context Protocol](https://modelcontextprotocol.io/) server that gives LLM clients access to SSH hosts through a named registry. The agent calls `ssh_exec` with `host_id` — addresses, users, ports and private keys stay in a local config file and never enter the model context.

Three transports are supported:

| Transport | Implementation | Tools |
|-----------|----------------|-------|
| `direct` | `ssh2` (Node.js) | exec, read, SFTP write (base64-exec fallback) |
| `ssh3` | spawns the `ssh3` Go client (QUIC over UDP) | exec, read, base64-exec write (≤48 KB) |
| `wsl` | WSL `bash -lc 'ssh …'` (proxied setups) | exec only |

## Features

- **Host registry** — `host_id` abstraction; the agent never guesses IP/user/key
- **Three transports** — direct `ssh2`, `ssh3` (QUIC over UDP), WSL-proxied SSH
- **File transfer** — SFTP with automatic base64-exec fallback for hosts without sftp-server (OpenWrt/dropbear), written bytes verified
- **RouterOS-aware** — MikroTik hosts flagged with `"shell": "routeros"`
- **Server instructions** — `docs/INSTRUCTIONS.md` is served to the MCP client automatically
- **Agent Skills** — a ready [SKILL.md](skills/ssh-hosts/SKILL.md) for skill-aware clients (copy to the client's `skills/` directory)
- **Safety rails** — rejects literal `undefined`/`null` file paths, propagates remote exit codes (incl. win32 unsigned 32-bit fixup)
- **Local-first config** — real addresses live in a gitignored `hosts.local.json`; the repository ships an anonymized template

## Tools

| Tool | Purpose |
|------|---------|
| `ssh_list_hosts` | List configured hosts and metadata |
| `ssh_exec` | Run a remote command |
| `ssh_read_file` | Read a remote file (`cat`) |
| `ssh_write_file` | Write a remote file (SFTP on direct hosts, base64-exec on ssh3; ≤48 KB) |

## Installation

```bash
git clone https://github.com/nagual2/ssh-hosts-mcp.git
cd ssh-hosts-mcp
npm install
npm test
```

## MCP configuration

Generic `mcpServers` entry (Claude Desktop, Cursor, ZCode, …):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-hosts-mcp/index.mjs"],
      "env": {
        "SSH_HOSTS_CONFIG": "/path/to/hosts.local.json"
      }
    }
  }
}
```

Config precedence: `SSH_HOSTS_CONFIG` env override → `hosts.local.json` (real addresses, gitignored) → `hosts.json` (anonymized template, safe to publish).

## Host configuration

```json
{
  "version": 1,
  "hosts": {
    "my-host": {
      "label": "Linux box",
      "transport": "direct",
      "host": "192.0.2.10",
      "user": "root",
      "port": 22,
      "privateKeyPath": "~/.ssh/id_ed25519"
    },
    "my-ssh3-host": {
      "label": "Same box over ssh3",
      "transport": "ssh3",
      "host": "server.example.lan",
      "port": 443,
      "urlPath": "/ssh3-term",
      "user": "user",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "clientPath": "ssh3-client"
    },
    "my-proxy-host": {
      "label": "Reachable only through a proxy",
      "transport": "wsl",
      "wslHost": "alias-from-ssh-config",
      "user": "coder"
    }
  }
}
```

### Transports in detail

- **`direct`** — Node `ssh2` from the MCP host machine; `~` in `privateKeyPath` is expanded to the home directory.
- **`ssh3`** — spawns the ssh3 client (`clientPath`, default `ssh3-client` on PATH); all flags go before the positional `user@host:port/urlPath` target. The server certificate must be pinned in `~/.ssh3/known_hosts` (TOFU) or `"insecure": true` set (dev only). Requires ssh3 server ≥ 0.1.8 — use the [`nagual2/ssh3`](https://github.com/nagual2/ssh3) fork, which adds the `-privkey` flag.
- **`wsl`** — runs `wsl bash -lc 'ssh -o BatchMode=yes <wslHost> <command>'`; only `ssh_exec` is supported (use `cat` / `tar|ssh` for files).

Full field reference: [`hosts.json`](hosts.json) and [`docs/INSTRUCTIONS.md`](docs/INSTRUCTIONS.md).

## Design notes

- **48 KB base64-exec limit** — remote writes are embedded as `echo <base64> | base64 -d > file`; an ARG_MAX-safe ceiling, with the written size verified via `wc -c`.
- **Exit codes** — Go clients surface unsigned 32-bit codes on win32; `normalizeExitCode` maps them back to signed values.
- **`filePath`, not `path`** — the write schema uses `filePath`; a literal `"undefined"`/`"null"` path is rejected before touching the remote host.

## Testing

```bash
npm test   # node --test test/lib.test.mjs — pure helpers, no network
```

## License

[MIT](LICENSE) © 2026 nagual2

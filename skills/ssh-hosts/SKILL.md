---
name: ssh-hosts
description: Remote command execution and file transfer on hosts registered in the ssh-hosts-mcp registry (direct SSH, ssh3/QUIC, WSL-proxied). Use when running commands, reading or writing files on any configured host via the mcp__ssh__* tools (ssh_list_hosts, ssh_exec, ssh_read_file, ssh_write_file) instead of raw ssh/scp in the shell.
---

# ssh-hosts: remote operations via host registry

All connections go through named host profiles. Addresses, users, ports and private keys live in the server config — never guess them and never pass them in tool arguments.

## Workflow

1. Unsure about a `host_id` or its transport? Call **`ssh_list_hosts`** first.
2. Run remote commands with **`ssh_exec`** (`host_id` + `command`).
3. Read files with **`ssh_read_file`**, write with **`ssh_write_file`** — only on `direct` and `ssh3` hosts.

## Hard rules

| № | Rule |
|---|------|
| 1 | Always pass `host_id` from the registry — never embed IP, user or key paths |
| 2 | The write parameter is **`filePath`**, not `path` (a literal `"undefined"` is rejected by the server) |
| 3 | Verify success: check `success` and `exitCode` in the JSON response before trusting the result |
| 4 | `ssh_write_file` over `ssh3` is limited to 48 KB (base64-exec); prefer SFTP on `direct` hosts |
| 5 | Default timeout is 120000 ms — lower it for quick probes (`uname`, `ping`) |

## Transport quirks

- **RouterOS hosts** (`mikrotik-*`, `shell: "routeros"`): RouterOS CLI, not bash. Use `/system print` style commands; no `&&`, no pipes, no Linux paths.
- **WSL-proxied hosts** (`transport: "wsl"`, e.g. `dslab-ml`): `ssh_exec` only. For files use `ssh_exec` with `cat`, or `tar|ssh` manually from WSL.
- **ssh3 hosts**: the server certificate must be pinned (TOFU) on first use from a terminal; QUIC needs UDP open to the server port.
- **OpenWrt hosts** (dropbear): MCP file tools handle transfer transparently; only manual CLI `scp` needs `-O`.

## Anti-patterns

| Wrong | Right |
|-------|-------|
| `2>/dev/null` on remote commands | Show full stderr |
| Guessing IP/user/key in `ssh_exec` | Use `host_id` from the registry |
| bash syntax on `mikrotik-*` | RouterOS syntax |
| `ssh_read_file` on a `wsl` host | `ssh_exec` + `cat` |
| Assuming a write worked | Check `success`, `bytes`, then verify by read/exec |

Full field reference and configuration guide: [`docs/INSTRUCTIONS.md`](../../docs/INSTRUCTIONS.md).

---
name: ssh-hosts
description: Remote command execution, file transfer and health snapshots on hosts registered in the ssh-hosts-mcp registry (direct SSH, ssh3/QUIC, WSL-proxied). Use when running commands, reading files (byte-range paging), writing files or checking CPU/mem/disk/uptime via the mcp__ssh__* tools (ssh_list_hosts, ssh_exec, ssh_read_file, ssh_write_file, ssh_server_status) instead of raw ssh/scp in the shell. Commands may be blocked by the host's configured policy.
---

# ssh-hosts: remote operations via host registry

All connections go through named host profiles. Addresses, users, ports and private keys live in the server config — never guess them and never pass them in tool arguments.

## Workflow

1. Unsure about a `host_id` or its transport? Call **`ssh_list_hosts`** first (note `hostKeyPinned` per host).
2. Run remote commands with **`ssh_exec`** (`host_id` + `command`).
3. Read files with **`ssh_read_file`** (paged: default first 65536 bytes, continue with `offset=nextOffset`), write with **`ssh_write_file`** — only on `direct` and `ssh3` hosts.
4. Health snapshot with **`ssh_server_status`** — CPU/mem/disk/uptime in one call (busybox/OpenWrt and RouterOS aware).

## Hard rules

| № | Rule |
|---|------|
| 1 | Always pass `host_id` from the registry — never embed IP, user or key paths |
| 2 | The write parameter is **`filePath`**, not `path` (a literal `"undefined"` is rejected by the server) |
| 3 | Verify success: check `success` and `exitCode` in the JSON response before trusting the result |
| 4 | `ssh_write_file` over `ssh3` is limited to 48 KB (base64-exec); prefer SFTP on `direct` hosts |
| 5 | Default timeout is 120000 ms unless the host sets `timeoutMs` — lower it per call for quick probes (`uname`, `ping`) |
| 6 | `ssh_read_file` returns at most `limit` bytes (default 65536) — if `truncated`, continue with `offset: nextOffset` |
| 7 | Commands are policy-checked: a never-allowed denylist always applies, and hosts may define `policy.allow`/`policy.deny` — if blocked, the error names the rule; do not try to bypass it |
| 8 | Remote paths must be absolute POSIX without `..`; hosts may restrict them via `allowedPaths` |

## Transport quirks

- **RouterOS hosts** (`mikrotik-*`, `shell: "routeros"`): RouterOS CLI, not bash. Use `/system print` style commands; RouterOS pipes (`/log print | where …`) are valid syntax and allowed even in whitelist mode; no `&&`, no Linux paths.
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
| Reading a huge log in one call | Page with `offset`/`limit`, follow `nextOffset` |
| Retrying a policy-blocked command verbatim | Read the rule in the error, adjust the approach |

Full field reference and configuration guide: [`docs/INSTRUCTIONS.md`](../../docs/INSTRUCTIONS.md).

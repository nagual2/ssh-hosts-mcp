# ssh-hosts-mcp

**Deutsch** | [English](README.md) | [Русский](README.ru.md)

Einheitlicher SSH-MCP-Server mit Host-Registry — ein `host_id` pro Aufruf statt IPs, Benutzern und Schlüsselpfaden.

## Übersicht

ssh-hosts-mcp ist ein [Model Context Protocol](https://modelcontextprotocol.io/)-Server, der LLM-Clients über eine benannte Registry Zugriff auf SSH-Hosts gibt. Der Agent ruft `ssh_exec` mit `host_id` auf — Adressen, Benutzer, Ports und private Schlüssel bleiben in einer lokalen Konfigurationsdatei und gelangen nie in den Modellkontext.

Drei Transports werden unterstützt:

| Transport | Implementierung | Werkzeuge |
|-----------|-----------------|-----------|
| `direct` | `ssh2` (Node.js) | exec, Lesen, SFTP-Schreiben (base64-exec-Fallback) |
| `ssh3` | startet den Go-Client `ssh3` (QUIC über UDP) | exec, Lesen, base64-exec-Schreiben (≤48 KB) |
| `wsl` | WSL `bash -lc 'ssh …'` (Proxyszenarien) | nur exec |

## Funktionen

- **Host-Registry** — `host_id`-Abstraktion; der Agent rät nie IP/Benutzer/Schlüssel
- **Drei Transports** — direkt per `ssh2`, `ssh3` (QUIC über UDP), SSH über WSL-Proxy
- **Dateiübertragung** — SFTP mit automatischem base64-exec-Fallback für Hosts ohne sftp-server (OpenWrt/dropbear), geschriebene Bytes werden verifiziert
- **RouterOS-Bewusst** — MikroTik-Hosts werden mit `"shell": "routeros"` markiert
- **Server-Instruktionen** — `docs/INSTRUCTIONS.md` wird dem MCP-Client automatisch bereitgestellt
- **Agent Skills** — fertige [SKILL.md](skills/ssh-hosts/SKILL.md) für Clients mit Skills-Unterstützung (in das `skills/`-Verzeichnis des Clients kopieren)
- **Schutzschienen** — literale Pfade `undefined`/`null` werden abgelehnt, Exit-Codes des Remote-Befehls werden durchgereicht (inkl. Umwandlung vorzeichenloser 32-Bit-Codes unter win32)
- **Lokale Konfiguration zuerst** — echte Adressen liegen in einer gitignorierten `hosts.local.json`; im Repository liegt eine anonymisierte Vorlage

## Werkzeuge

| Werkzeug | Zweck |
|----------|-------|
| `ssh_list_hosts` | Konfigurierte Hosts und Metadaten auflisten |
| `ssh_exec` | Remote-Befehl ausführen |
| `ssh_read_file` | Remote-Datei lesen (`cat`) |
| `ssh_write_file` | Remote-Datei schreiben (SFTP auf direct-Hosts, base64-exec auf ssh3; ≤48 KB) |

## Installation

```bash
git clone https://github.com/nagual2/ssh-hosts-mcp.git
cd ssh-hosts-mcp
npm install
npm test
```

## MCP-Konfiguration

Universeller `mcpServers`-Eintrag (Claude Desktop, Cursor, ZCode, …):

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

Konfigurationspriorität: Umgebungsvariable `SSH_HOSTS_CONFIG` → `hosts.local.json` (echte Adressen, gitignoriert) → `hosts.json` (anonymisierte Vorlage, gefahrlos veröffentlichbar).

## Host-Konfiguration

```json
{
  "version": 1,
  "hosts": {
    "my-host": {
      "label": "Linux-Rechner",
      "transport": "direct",
      "host": "192.0.2.10",
      "user": "root",
      "port": 22,
      "privateKeyPath": "~/.ssh/id_ed25519"
    },
    "my-ssh3-host": {
      "label": "Derselbe Rechner über ssh3",
      "transport": "ssh3",
      "host": "server.example.lan",
      "port": 443,
      "urlPath": "/ssh3-term",
      "user": "user",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "clientPath": "ssh3-client"
    },
    "my-proxy-host": {
      "label": "Nur über einen Proxy erreichbar",
      "transport": "wsl",
      "wslHost": "alias-from-ssh-config",
      "user": "coder"
    }
  }
}
```

### Transports im Detail

- **`direct`** — Node `ssh2` von der MCP-Host-Maschine; `~` in `privateKeyPath` wird zum Home-Verzeichnis erweitert.
- **`ssh3`** — startet den ssh3-Client (`clientPath`, Standard `ssh3-client` aus dem PATH); alle Flags stehen vor dem positionalen Ziel `user@host:port/urlPath`. Das Server-Zertifikat muss in `~/.ssh3/known_hosts` gepinnt sein (TOFU), alternativ `"insecure": true` (nur für die Entwicklung). Erfordert ssh3-Server ≥ 0.1.8 — den Fork [`nagual2/ssh3`](https://github.com/nagual2/ssh3) verwenden, der das Flag `-privkey` ergänzt.
- **`wsl`** — führt `wsl bash -lc 'ssh -o BatchMode=yes <wslHost> <command>'` aus; nur `ssh_exec` wird unterstützt (für Dateien: `cat` / `tar|ssh`).

Vollständige Feldreferenz: [`hosts.json`](hosts.json) und [`docs/INSTRUCTIONS.md`](docs/INSTRUCTIONS.md).

## Design-Notizen

- **48-KB-base64-exec-Limit** — Schreibvorgänge werden als `echo <base64> | base64 -d > file` eingebettet; ARG_MAX-sichere Obergrenze, die geschriebene Größe wird per `wc -c` verifiziert.
- **Exit-Codes** — Go-Clients liefern unter win32 vorzeichenlose 32-Bit-Codes; `normalizeExitCode` bildet sie auf vorzeichenbehaftete Werte zurück.
- **`filePath`, nicht `path`** — das Schreibschema verwendet `filePath`; literale Pfade `"undefined"`/`"null"` werden vor dem Zugriff auf den Host abgelehnt.

## Tests

```bash
npm test   # node --test test/lib.test.mjs — reine Helfer, ohne Netzwerk
```

## Lizenz

[MIT](LICENSE) © 2026 nagual2

# ssh-hosts-mcp

**Русский** | [English](README.md) | [Deutsch](README.de.md)

Единый SSH MCP-сервер с реестром хостов — один `host_id` на вызов вместо IP, пользователей и путей к ключам.

## Обзор

ssh-hosts-mcp — это сервер [Model Context Protocol](https://modelcontextprotocol.io/), который даёт LLM-клиентам доступ к SSH-хостам через именованный реестр. Агент вызывает `ssh_exec` с `host_id` — адреса, пользователи, порты и приватные ключи остаются в локальном конфиге и не попадают в контекст модели.

Поддерживаются три транспорта:

| Транспорт | Реализация | Инструменты |
|-----------|------------|-------------|
| `direct` | `ssh2` (Node.js) | exec, чтение, SFTP-запись (fallback base64-exec) |
| `ssh3` | запуск Go-клиента `ssh3` (QUIC поверх UDP) | exec, чтение, запись base64-exec (≤48 КБ) |
| `wsl` | WSL `bash -lc 'ssh …'` (проксируемые сценарии) | только exec |

## Возможности

- **Реестр хостов** — абстракция `host_id`; агент никогда не угадывает IP/пользователя/ключ
- **Три транспорта** — прямой `ssh2`, `ssh3` (QUIC поверх UDP), SSH через WSL-прокси
- **Передача файлов** — SFTP с автоматическим fallback на base64-exec для хостов без sftp-server (OpenWrt/dropbear), с проверкой числа записанных байт
- **Поддержка RouterOS** — хосты MikroTik помечаются `"shell": "routeros"`
- **Инструкции сервера** — `docs/INSTRUCTIONS.md` отдаётся MCP-клиенту автоматически
- **Agent Skills** — готовый [SKILL.md](skills/ssh-hosts/SKILL.md) для клиентов с поддержкой skills (скопировать в каталог `skills/` клиента)
- **Защита от ошибок** — отвергаются литеральные пути `undefined`/`null`, пробрасываются коды возврата удалённой команды (включая конвертацию беззнаковых 32-битных кодов на win32)
- **Локальный конфиг** — реальные адреса живут в gitignore-нутом `hosts.local.json`; в репозитории — обезличенный шаблон

## Инструменты

| Инструмент | Назначение |
|------------|------------|
| `ssh_list_hosts` | Список настроенных хостов и их метаданных |
| `ssh_exec` | Выполнить команду на удалённом хосте |
| `ssh_read_file` | Прочитать удалённый файл (`cat`) |
| `ssh_write_file` | Записать удалённый файл (SFTP на direct-хостах, base64-exec на ssh3; ≤48 КБ) |

## Установка

```bash
git clone https://github.com/nagual2/ssh-hosts-mcp.git
cd ssh-hosts-mcp
npm install
npm test
```

## Конфигурация MCP

Универсальный блок `mcpServers` (Claude Desktop, Cursor, ZCode, …):

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

Приоритет конфига: переменная окружения `SSH_HOSTS_CONFIG` → `hosts.local.json` (реальные адреса, gitignored) → `hosts.json` (обезличенный шаблон, безопасно публиковать).

## Конфигурация хостов

```json
{
  "version": 1,
  "hosts": {
    "my-host": {
      "label": "Linux-машина",
      "transport": "direct",
      "host": "192.0.2.10",
      "user": "root",
      "port": 22,
      "privateKeyPath": "~/.ssh/id_ed25519"
    },
    "my-ssh3-host": {
      "label": "Та же машина по ssh3",
      "transport": "ssh3",
      "host": "server.example.lan",
      "port": 443,
      "urlPath": "/ssh3-term",
      "user": "user",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "clientPath": "ssh3-client"
    },
    "my-proxy-host": {
      "label": "Доступна только через прокси",
      "transport": "wsl",
      "wslHost": "alias-from-ssh-config",
      "user": "coder"
    }
  }
}
```

### Транспорты подробно

- **`direct`** — Node `ssh2` с машины, где работает MCP-сервер; `~` в `privateKeyPath` разворачивается в домашний каталог.
- **`ssh3`** — запускает ssh3-клиент (`clientPath`, по умолчанию `ssh3-client` из PATH); все флаги ставятся перед позиционным аргументом `user@host:port/urlPath`. Сертификат сервера должен быть закреплён в `~/.ssh3/known_hosts` (TOFU), либо установлен `"insecure": true` (только для разработки). Требуется ssh3-сервер ≥ 0.1.8 — используйте форк [`nagual2/ssh3`](https://github.com/nagual2/ssh3), добавляющий флаг `-privkey`.
- **`wsl`** — выполняет `wsl bash -lc 'ssh -o BatchMode=yes <wslHost> <command>'`; поддерживается только `ssh_exec` (для файлов — `cat` / `tar|ssh`).

Полное описание полей: [`hosts.json`](hosts.json) и [`docs/INSTRUCTIONS.md`](docs/INSTRUCTIONS.md).

## Заметки о дизайне

- **Лимит base64-exec 48 КБ** — запись встраивается в команду `echo <base64> | base64 -d > file`; потолок безопасен по ARG_MAX, размер записи проверяется через `wc -c`.
- **Коды возврата** — Go-клиенты на win32 отдают беззнаковые 32-битные коды; `normalizeExitCode` возвращает их к знаковым значениям.
- **`filePath`, а не `path`** — схема записи использует `filePath`; литеральные пути `"undefined"`/`"null"` отвергаются до обращения к хосту.

## Тесты

```bash
npm test   # node --test test/lib.test.mjs — чистые хелперы, без сети
```

## Лицензия

[MIT](LICENSE) © 2026 nagual2

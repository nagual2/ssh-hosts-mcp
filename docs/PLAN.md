# PLAN — ssh-hosts-mcp

План доработки функционала. Составлен 2026-10-17 после сравнения с `overklassniy/ssh-mcp` и разведки GitHub (см. §«Разведка»); ранжирование по ценности/цене уточнено в тот же день.

Текущее состояние: v1.1.2, транспорты `direct` / `ssh3` / `wsl`; tools: `ssh_list_hosts`, `ssh_exec`, `ssh_read_file`, `ssh_write_file`. Существующие гварды: `timeoutMs` на соединение/exec, `BASE64_EXEC_MAX_BYTES = 48_000`. Host-key verification есть только в ssh3 (TOFU); direct (ssh2) и wsl — нет.

## Часть 1 — приоритет (реально пригодится)

Порядок строк = порядок реализации: 1–3 быстрые победы, 4–5 security-слой (делать единым блоком), 6–7 удобства.

| № | Пункт | Что делать | Источник идеи | Критерий приёмки |
|---|-------|------------|---------------|------------------|
| 1 | 🔒 Исправление уязвимости: host-key verification для direct/wsl | [SECURITY FIX] pin отпечатка в hosts-конфиге или TOFU-файл (по образцу ssh3); хост без pin — явная пометка в `ssh_list_hosts`; несовпадение отпечатка → отказ соединения | `tufantunc` (`trustedHostKey` pin), `bvisible` (отказ при смене ключа) | unit-тест: несовпадение отпечатка → отказ; отсутствие pin — пометка в списке хостов |
| 2 | Лимит вывода exec | `maxOutputBytes` с усечением и структурированным кодом ошибки; per-host `timeoutMs` override | `overklassniy/ssh-mcp` (`[defaults]`), `classfang` (10 MiB default, `OUTPUT_LIMIT_EXCEEDED`) | unit-тест обрезки; отсутствие лимита в конфиге — прежнее поведение |
| 3 | Hot-reload реестра | проверка mtime hosts-файла при каждом вызове; правки подхватываются без рестарта MCP-сервера | `overklassniy/ssh-mcp`, `bvisible` | unit-тест: правка tmp-конфига видна на следующем вызове |
| 4 | Policy-фильтр команд | whitelist/blacklist regex для `ssh_exec` (глобальный defaults + per-host override); встроенный «never-allowed» denylist по умолчанию (`rm -rf /`, `mkfs`, `dd of=/dev/`, `curl\|sh`, fork-бомбы); в whitelist-режиме дополнительно отклонять метасимволы склейки (`; & \| \` $() > <` \n); deny побеждает, fail-closed | `overklassniy/ssh-mcp`, `classfang` (метасимвол-гварды), `tufantunc` (never-allowed), `bvisible` (deny wins) | unit-тесты: deny блокирует, allow приоритетнее, метасимвол в whitelist-режиме отклонён, ошибка называет сработавшее правило; E2E на prod-openwrt |
| 5 | Confinement путей | `allowedPaths` (списки read/write) на хост; отказ `..`-traversal; удалённый путь — абсолютный POSIX. Делать **после п.4**: без policy-фильтра обходится через обычный `cat` в `ssh_exec` | `overklassniy/ssh-mcp`, `classfang` | unit-тесты: traversal отклонён, путь вне allowed отклонён, легитимные проходят |
| 6 | Постраничное чтение файлов | offset/limit в `ssh_read_file` для больших логов; дефолтное усечение (~64 KB) с пометкой и следующим offset | `classfang` (read-file pagination), `slepp` (`view_range`) | unit-тест: окно чтения, усечение, продолжение со смещения |
| 7 | tool `ssh_server_status` | CPU/mem/disk/uptime одной командой; варианты для busybox/OpenWrt и RouterOS (`"shell": "routeros"`) | `overklassniy/ssh-mcp`, `bvisible` (`ssh_health_check`) | unit-тесты парсеров; E2E на prod-openwrt |

## Часть 2 — заморожено (всё остальное)

> Не реализовывать без явного запроса Пилота.

| № | Пункт | Комментарий |
|---|-------|-------------|
| 1 | SFTP upload/download бинарных файлов + streaming мимо контекста модели + tool `list-remote` | текстовые сценарии покрыты `ssh_exec`/`ssh_read_file`/`ssh_write_file` |
| 2 | `dir-sync` / rsync-синхронизация каталогов | тяжёлый отдельный data-path |
| 3 | `port-forward` local/remote (open/close/list) | долгоживущие туннели — другая модель жизненного цикла; у `slepp` это отдельный permission-gated tool |
| 4 | Аутентификация паролем / keyboard-interactive 2FA | инфраструктура на ключах; при разморозке — секреты только через env; паттерн `@password`-аннотации из `AiondaDotCom/mcp-ssh` |
| 5 | Интерактивные персистентные сессии (CWD/env retention) | stateful, POSIX-only |
| 6 | CLI-режим одного хоста (`--host/--user/--port/--key`) | реестр покрывает; per-call креды против идеи host_id |
| 7 | Дистрибуция: npm-пакет / Docker-образ / MCPB-бандл | отдельное решение при публичной публикации |
| 8 | Keepalive-политики (interval/count) | низкий приоритет |
| 9 | HTTP-транспорт MCP (bearer token, rate-limit, DNS-rebinding guard) | локальный stdio-клиент достаточен |
| 10 | Аудит-лог (JSONL + redaction секретов, опц. hash-chain) | ценно для multi-user, у нас один Пилот |
| 11 | Approval-воркфлоу: классификация команд, роль×tier матрица, OPA, JIT-гранты | enterprise-уровень `tufantunc`; избыточно для single-Pilot, но никогда-не-разрешённый denylist взят в часть 1 |
| 12 | Автодискавери хостов из `~/.ssh/config` (+Include-парсинг) | против идеи явного реестра `hosts.local.json` |
| 13 | Активация/деактивация групп инструментов | актуально, если tools перевалит за ~10 (у `bvisible` 37→5, −92% контекста) |
| 14 | `commandTemplate`-обёртки (sudo bash -c / docker exec) | сценариев нет |
| 15 | Фоновые долгие команды (bg-флаг `ssh_exec` → job_id, poll вывода, kill) | отложено: state-машина заметно дороже пунктов части 1; **разморозить при первом реальном сценарии** «команда длиннее таймаута» (идея — `classfang` job-start/status/kill) |

## Разведка GitHub (2026-10-17)

Проанализированы README + публичные доки; поиск: «ssh mcp server», «mcp ssh remote» (GitHub API, sort by stars).

| № | Проект | ★ | Стек | Суть / что взяли |
|---|--------|---|------|------------------|
| 1 | [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) | 957 | TS | Оригинал (вдохновил overklassniy), в офиц. MCP-каталоге. Взяли: пагинацию чтения (часть 1 п.6), метасимвол-гварды whitelist (п.4), structured output-limit error (п.2); фоновые jobs → часть 2 п.15. Уникальное: shell-режим для бастионов, SOCKS/HTTP-прокси, commandTemplate |
| 2 | [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) | 809 | TS | Security-first: классификация команд, роль×tier, approval через MCP elicitation, OPA, SLSA L2. Взяли: host-key pin (часть 1 п.1), never-allowed denylist (п.4). Уникальное: streaming SFTP мимо контекста, hash-chain audit, «AI_AGENT=ssh-mcp» на хосте |
| 3 | [bvisible/mcp-ssh-manager](https://github.com/bvisible/mcp-ssh-manager) | 508 | Node | 37 tools: backup/restore БД, деплой, туннели, aliases, hooks. Взяли: hot-reload подтверждение (часть 1 п.3), идею групп tools (часть 2 п.13), пометку хоста без pin (п.1). Уникальное: активация групп tools (37→5), readonly/restricted/unrestricted режимы на хост |
| 4 | [AiondaDotCom/mcp-ssh](https://github.com/AiondaDotCom/mcp-ssh) | 101 | TS | Обёртка над системным ssh/scp, автодискавери из `~/.ssh/config` (Include-парсинг), `@password`-аннотации. Взяли: пароль-паттерн в часть 2 п.4 |
| 5 | [slepp/ssh-mcp](https://github.com/slepp/ssh-mcp) | 30 | Python | Обёртка над локальным OpenSSH: view/create/edit/grep/glob на удалённом, интерактивные сессии, tmux-наблюдение, rsync. Взяли: paging-идею (часть 1 п.6) |
| 6 | [overklassniy/ssh-mcp](https://github.com/overklassniy/ssh-mcp) | 32 | Go | Первичный триггер сравнения: policy regex, allowed paths, hot-reload, max output bytes, port-forward, dir-sync, server-status — разошлись по частям 1–2 |

Посмотрели в выдаче, не анализировали: `uarlouski/ssh-mcp-server` (37★, TS, «secure production-ready»), `danmartuszewski/hop` (65★, Go, SSH-менеджер с TUI+MCP).

**Выводы разведки:**
1. Host-реестр вместо per-call кредов — консенсус рынка; наша двухуровневая схема (`hosts.json` публичный шаблон + `hosts.local.json` gitignored) — сильнее типичной.
2. Наш уникальный признак — ssh3/QUIC-транспорт: его нет ни у кого из шестёрки.
3. Главная найденная дыра нашего кода — отсутствие host-key verification на direct/wsl (часть 1 п.1, помечено как исправление уязвимости); у `tufantunc` — эталонное решение, у `bvisible` — отказ при смене ключа.
4. Defense-in-depth (policy + confinement + output limit + never-allowed) — общий знаменатель зрелых проектов; в части 1 собран минимальный набор (пп. 1–5).

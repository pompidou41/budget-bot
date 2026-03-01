# Разработка в WSL (Windows Subsystem for Linux)

Проект разрабатывается локально на **Windows 11 + WSL2 (Ubuntu)**.

## Конфигурация путей

### Для Claude Code (VS Code Extension)

Claude Code обращается к файлам через **WSL UNC-пути**:

```
\\wsl.localhost\Ubuntu\home\musae\projects\budget-bot
```

Эта конфигурация зафиксирована в [`.claude/settings.local.json`](.claude/settings.local.json):

```json
{
  "permissions": {
    "additionalDirectories": [
      "\\wsl.localhost\\Ubuntu\\home\\musae\\projects\\budget-bot"
    ]
  }
}
```

**Важно:** при обращении к файлам из Claude Code используются **обратные слеши** (`\\`) и **UNC-путь** (`\\wsl.localhost\\Ubuntu\\...`), а не Windows-пути (`C:\...`).

---

## Для терминальных команд

При вызове команд из Claude Code Terminal (или любого другого терминала) необходимо использовать **WSL-синтаксис**:

### Пример 1: Запуск yarn-команды

```bash
wsl -d Ubuntu -- bash -lc "cd /home/musae/projects/budget-bot && yarn typecheck 2>&1"
```

**Разбор:**
- `wsl -d Ubuntu` — запустить команду в дистрибутиве Ubuntu
- `bash -lc` — bash в режиме login shell (загружает `.bashrc`, `.profile`)
- `cd /home/musae/projects/budget-bot` — перейти в папку проекта (Unix-пути внутри WSL)
- `yarn typecheck 2>&1` — выполнить команду

### Пример 2: Запуск в dev-режиме

```bash
wsl -d Ubuntu -- bash -lc "cd /home/musae/projects/budget-bot && yarn dev"
```

### Пример 3: Проверка кода

```bash
wsl -d Ubuntu -- bash -lc "cd /home/musae/projects/budget-bot && yarn lint:fix && yarn format"
```

---

## Альтернативный способ: прямое обращение к bash

Если вы запускаете команду прямо из bash в WSL:

```bash
cd /home/musae/projects/budget-bot
yarn dev
```

Unix-пути внутри WSL используются **без** префикса `\\wsl.localhost\\`.

---

## Шпаргалка: File Read vs Bash

| Операция | Синтаксис | Пример |
|----------|-----------|---------|
| **Claude Code читает файл** (File Tool) | UNC-путь (`\\wsl.localhost\\...`) | `\\wsl.localhost\\Ubuntu\\home\\musae\\projects\\budget-bot\\src\\index.ts` |
| **Bash выполняет команду** (Bash Tool) | WSL-синтаксис (`wsl -d Ubuntu -- bash -lc "..."`) | `wsl -d Ubuntu -- bash -lc "cd /home/musae/projects/budget-bot && yarn dev"` |
| **Прямой вызов в bash (вне Claude Code)** | Unix-пути (`/home/...`) | `cd /home/musae/projects/budget-bot && yarn dev` |

---

## Ограничения и особенности

1. **Paths.resolve() в коде** — всегда используются Unix-пути (`/home/musae/...`), потому что код работает **внутри WSL** (Linux).
2. **Git в WSL** — `.gitignore` использует Unix-пути (`data/budget-bot.db`, не `data\\budget-bot.db`).
3. **Environment variables** — в `.env` и `.env.example` используются Unix-пути.
4. **CI/CD** — GitHub Actions работает с Unix-путями (как и на любом Linux-сервере).

---

## Связанные файлы

- [`.claude/settings.local.json`](.claude/settings.local.json) — конфигурация Claude Code для WSL
- [CLAUDE.md](../CLAUDE.md) — основная документация проекта
- [INFRA.md](INFRA.md) — описание инфраструктуры и деплоя

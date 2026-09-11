# Infrastructure

## Architecture Overview

| Компонент       | Технология     | Назначение                                          |
| --------------- | -------------- | --------------------------------------------------- |
| Process manager | PM2            | Автозапуск при ребуте, перезапуск при краше         |
| CI/CD           | GitHub Actions | typecheck/lint/test → авто-деплой на push в main    |
| Логи            | PM2 logs       | Логи процесса через `pm2 logs` (pino JSON)          |
| Секреты         | GitHub Secrets | Источник правды для всех env-переменных             |
| Внешние API     | Google Sheets, OpenRouter, Groq, Telegram | Таблица, AI-разбор, расшифровка голоса |

---

## Host Environment

- **Сервер**: Aeza VPS, Ubuntu 24.04
- **Пользователь**: `work`
- **Node.js**: 24 LTS via Homebrew (`/home/linuxbrew/.linuxbrew/opt/node@24/bin/node`)
- **yarn**: classic 1.x (`/home/work/.yarn/bin`), lockfile v1
- **PM2**: глобально через yarn/npm
- **Проект**: `/home/work/projects/budget-bot`

---

## PM2 — Управление процессом

```bash
pm2 status                        # список всех процессов и их статус
pm2 show budget-bot               # детали процесса
pm2 restart budget-bot            # перезапуск
pm2 reload budget-bot             # graceful-перезапуск (SIGTERM → bot.stop())
pm2 stop budget-bot               # остановить
pm2 delete budget-bot             # удалить из PM2
pm2 monit                         # интерактивный dashboard
```

---

## Логирование

PM2 хранит логи в `~/.pm2/logs/`:

```bash
pm2 logs budget-bot               # live tail
pm2 logs budget-bot --lines 100   # последние 100 строк
pm2 logs budget-bot --err         # только stderr
pm2 flush budget-bot              # очистить логи
```

Файлы логов:

- `~/.pm2/logs/budget-bot-out.log` — stdout (pino JSON, `NODE_ENV=production` из `ecosystem.config.cjs`)
- `~/.pm2/logs/budget-bot-error.log` — stderr

---

## Деплой

### Автоматический (GitHub Actions)

При каждом пуше в ветку `main`:

1. Job `check`: `yarn install --frozen-lockfile`, `yarn typecheck`, `yarn lint`, `yarn test`
2. Job `deploy` (только если `check` зелёный): проверка обязательных секретов
3. SSH на хост → запись `.env` из Secrets/Variables → `scripts/deploy.sh`

Workflow: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)

### Ручной (с хоста)

```bash
cd /home/work/projects/budget-bot
bash scripts/deploy.sh
```

Скрипт: [`scripts/deploy.sh`](../scripts/deploy.sh). Предполагает, что `.env` уже существует на хосте.

---

## Environment Variables

**Источник правды**: GitHub Secrets и Variables (Settings → Secrets and variables → Actions).

Файл на хосте: `/home/work/projects/budget-bot/.env` (права 600, не в git).

| Переменная                     | Обяз. | Описание                                                        |
| ------------------------------ | ----- | --------------------------------------------------------------- |
| `BOT_TOKEN`                    | да    | Токен от @BotFather                                             |
| `OWNER_TELEGRAM_ID`            | да    | Telegram user ID владельца; все остальные апдейты игнорируются |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | да    | Email сервисного аккаунта Google                                |
| `GOOGLE_PRIVATE_KEY`           | да    | Приватный PEM-ключ сервисного аккаунта                          |
| `OPENROUTER_API_KEY`           | да    | Ключ OpenRouter (AI-разбор текста и картинок)                   |
| `GROQ_API_KEY`                 | да    | Ключ Groq (расшифровка голосовых)                               |
| `SPREADSHEET_ID`               | нет   | ID таблицы; по умолчанию «Расходы/доходы» v2                    |
| `OPENROUTER_MODEL`             | нет   | По умолчанию `google/gemini-3.7-flash`                          |
| `GROQ_STT_MODEL`               | нет   | По умолчанию `whisper-large-v3-turbo`                           |
| `BOT_TIMEZONE`                 | нет   | По умолчанию `Europe/Moscow`                                    |
| `LOG_LEVEL`                    | да    | `fatal`/`error`/`warn`/`info`/`debug`/`trace`                   |

Пустое значение необязательной переменной = значение по умолчанию.

**Журнал записей**: `data/journal.json` — последние 50 строк, записанных ботом (для `/undo`). Директория `data/`
создаётся автоматически (и скриптом деплоя через `mkdir -p`). Больше бот ничего на диске не хранит.

**Важно про `GOOGLE_PRIVATE_KEY`**: в GitHub Secret и в файле `.env` ключ должен быть записан как **одна строка** с `\n`
литералами (как в `.env.example`). `node --env-file` автоматически разворачивает `\n` в реальные переносы строк.

**Доступ к таблице**: сервисный аккаунт должен быть **редактором** таблицы v2 (Поделиться → email сервисного аккаунта).
Проверка с локальной машины: `yarn check-sheet`.

### Синхронизация env между машинами

```bash
# Отправить локальный .env на хост (разовая операция или при изменении)
scp -P 22 .env work@HOST:/home/work/projects/budget-bot/.env

# Скачать .env с хоста локально
scp -P 22 work@HOST:/home/work/projects/budget-bot/.env .env
```

---

## GitHub Secrets и Variables

Настроить в: GitHub → репозиторий → Settings → Secrets and variables → Actions.

**Secrets:**

| Secret                         | Значение                                             |
| ------------------------------ | ---------------------------------------------------- |
| `SSH_HOST`                     | IP-адрес Aeza VPS                                    |
| `SSH_USER`                     | `work`                                               |
| `SSH_PORT`                     | `22` (или кастомный порт из sshd_config)             |
| `SSH_PRIVATE_KEY`              | Приватный ed25519-ключ для деплоя (создать отдельно) |
| `BOT_TOKEN`                    | —                                                    |
| `OWNER_TELEGRAM_ID`            | Telegram user ID владельца                           |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | —                                                    |
| `GOOGLE_PRIVATE_KEY`           | —                                                    |
| `OPENROUTER_API_KEY`           | —                                                    |
| `GROQ_API_KEY`                 | —                                                    |

**Variables:** `LOG_LEVEL` (`info`), опционально `SPREADSHEET_ID`, `OPENROUTER_MODEL`, `GROQ_STT_MODEL`, `BOT_TIMEZONE`.

Секрет `ADMIN_USER_ID` от v1 больше не используется — можно удалить.

---

## Переход с v1 (разово)

1. Выдать сервисному аккаунту доступ редактора к таблице v2.
2. Добавить секреты `OWNER_TELEGRAM_ID`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`.
3. После первого деплоя на хосте можно удалить `data/budget-bot.db*` (SQLite v1 больше не читается).

---

## Troubleshooting

**Бот не запускается:**

```bash
pm2 logs budget-bot --lines 50   # смотреть ошибки
pm2 show budget-bot              # статус и пути к логам
```

Частая причина — не задана обязательная переменная: в логе будет `Invalid environment variables`.

**Бот пишет «Запись в таблицу отключена — шапка листа «Операции» не совпадает»:**
заголовки `Операции!A1:K1` изменились. Вернуть их (см. `EXPECTED_HEADERS` в `src/sheets/schema-check.ts`) и нажать `/refresh`.

**«Не получилось разобрать: OpenRouter 404 … data policy»:** у модели нет провайдера, подходящего под
`data_collection: 'deny'`, — сменить `OPENROUTER_MODEL` или разрешить провайдеров в настройках OpenRouter.

**Деплой завершился ошибкой в GitHub Actions:**

- Проверить вкладку Actions в GitHub — там полный лог
- Упал job `check` — ошибка типов/линта/тестов, деплой не выполнялся
- Частые причины в `deploy`: неправильный SSH-ключ, `yarn.lock` не синхронизирован, не заданы новые секреты

**PM2 не находит процесс после ребута:**

```bash
pm2 startup   # повторить настройку автозапуска
pm2 save      # сохранить список процессов
```

**Проверить, что бот слушает Telegram:**

```bash
pm2 logs budget-bot --lines 10   # должно быть "Starting bot..." и "Bot started"
```

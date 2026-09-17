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

- **Сервер**: Aeza VPS, Ubuntu 24.04, `77.221.149.188` (Tailscale: `ops-aeza`)
- **Админ-доступ**: пользователь `ops` (sudo), вход только по ключу, root по SSH запрещён; ufw пускает только OpenSSH
- **Пользователь бота**: `work` (без sudo), в `authorized_keys` — deploy-ключ GitHub Actions
- **Node.js**: 24 LTS из NodeSource (`/usr/bin/node`)
- **yarn**: classic 1.22.22 (`npm i -g yarn@1.22.22`, `/usr/bin/yarn`), lockfile v1
- **PM2**: `npm i -g pm2`, автозапуск через systemd-юнит `pm2-work` (`pm2 startup systemd -u work --hp /home/work`)
- **Проект**: `/home/work/projects/budget-bot` (клон публичного репо по HTTPS)

### Установка с нуля (выполнено 11.09.2026)

```bash
# под ops
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g yarn@1.22.22 pm2
sudo useradd -m -s /bin/bash work
sudo -u work git clone https://github.com/pompidou41/budget-bot.git /home/work/projects/budget-bot
sudo env PATH="$PATH" pm2 startup systemd -u work --hp /home/work
# публичную часть deploy-ключа → /home/work/.ssh/authorized_keys, приватную → секрет SSH_PRIVATE_KEY
```

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
| `OPENROUTER_ANALYST_MODEL`     | нет   | Модель для `/ask` и `/review`, в GitHub Variables — `anthropic/claude-sonnet-5`; пусто — берётся `OPENROUTER_MODEL`. Для `anthropic/*` включается reasoning |
| `GROQ_STT_MODEL`               | нет   | По умолчанию `whisper-large-v3-turbo`                           |
| `BOT_TIMEZONE`                 | нет   | По умолчанию `Europe/Moscow`                                    |
| `RENDER_MODE`                  | нет   | `rich` (по умолчанию) или `html` — откат на обычный HTML-рендер  |
| `LOG_LEVEL`                    | да    | `fatal`/`error`/`warn`/`info`/`debug`/`trace`                   |

Пустое значение необязательной переменной = значение по умолчанию.

**Состояние на диске**: `data/journal.json` — последние 50 строк, записанных ботом (для `/undo`);
`data/settings.json` — настройки из `/settings` (счёт по умолчанию, заметки для ИИ; старые алиасы переносятся
в заметки автоматически при чтении);
`data/drafts.json` — незавершённые черновики (TTL 24 ч);
`data/conversations.json` — треды `/ask`, привязанные к сообщению-ответу (история 24 ч).
Последние два появились, чтобы reply на сообщение бота продолжал работать после `pm2 reload`.
Директория `data/` создаётся автоматически (и скриптом деплоя через `mkdir -p`) и переживает деплой.
Больше бот ничего на диске не хранит.

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

**Variables:** `LOG_LEVEL` (`info`), опционально `SPREADSHEET_ID`, `OPENROUTER_MODEL`, `OPENROUTER_ANALYST_MODEL`,
`GROQ_STT_MODEL`, `BOT_TIMEZONE`, `RENDER_MODE`.

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

**«Не получилось разобрать: OpenRouter 404 … data policy / ZDR»:** у модели не осталось провайдеров под настройки
приватности аккаунта OpenRouter (Settings → Privacy, в аккаунте включён Zero Data Retention). Бот не добавляет своих
фильтров `provider` именно поэтому: с `require_parameters` ZDR-endpoint'ы Google отсекались. Если ошибка вернулась после
смены модели — выбрать модель с ZDR-провайдером или изменить настройки аккаунта. Список ZDR-эндпоинтов можно
проверить запросом к `https://openrouter.ai/api/v1/endpoints/zdr`; у `anthropic/claude-sonnet-5` они есть на
Amazon Bedrock и Google Vertex.

Какой провайдер ответит, решает маршрутизация, и они ведут себя по-разному (перепроверено 2026-09-18):
**Bedrock** и **Vertex** оба принимают `response_format`, но ни один не помечен как поддерживающий
`structured_outputs` — схему держат «по возможности», не гарантированно; `reasoning.effort` оба игнорируют, работает
только `reasoning.max_tokens`. **Azure** в аккаунте включён, но его эндпоинты отсекаются фильтром политики данных
(`0 endpoints out of 2 ... matching your guardrail restrictions`) и не используются.

Прибить маршрутизацию к провайдеру, который честно держит схему, **нельзя**: `structured_outputs` заявляют только
`anthropic` и `claude-on-aws`, а allow-list аккаунта (Settings → Privacy) разрешает
`azure, phala, google-vertex, moonshotai, sail-research, amazon-bedrock, google-ai-studio` — оба нужных отрезаны.
Любой `provider.only` с ними, как и `require_parameters`, даёт 404 `No allowed providers are available`.
Поэтому клиент всегда кладёт схему в промпт, спускается по лестнице и на 400, и на ответ-не-JSON, и задаёт
reasoning бюджетом токенов, а не `effort`.

**Подсказка про JSON уходит ролью `user`, а не `system`** (важно, 2026-09-18). Провайдеры, обслуживающие Claude,
склеивают все `system`-сообщения в один блок наверху промпта — инструкция «ответ только JSON» улетала в начало и
тонула под правилами аналитика, где рядом лежит «пиши обычным текстом». В первом раунде `/ask` она ещё побеждала
(12 из 12 замеров — JSON), а во втором, после подгрузки сырых строк, проигрывала: 1 из 9. После переноса в `user` —
6 из 6 на том же сценарии. Страховка сверху: `parseJsonContent` вытаскивает первый сбалансированный объект из прозы,
но обрезанный JSON через неё не проходит — там лестница обязана шагнуть вниз.

До 2026-09-14 `deploy.yml` не прокидывал в `.env` ни `OPENROUTER_ANALYST_MODEL`, ни `RENDER_MODE` — значения
из GitHub Variables на сервер не попадали. Теперь обе переменные записываются.

**В логах `Provider did not honour the response format, stepping down`:** это не ошибка. ZDR-маршрутизация увела запрос
на эндпоинт, который отказал в формате (400) или ответил прозой вместо JSON (так делают и Vertex, и Bedrock),
и `completeJson` спустился на ступень ниже — `json_object`, затем схема прямо в промпте. Ответ всё равно валидируется zod. Постоянные срабатывания на
первой ступени означают лишь, что для этой модели strict-схема недоступна.

Если же в логах `Failed to answer a finance question` с `returned non-JSON content`, а перед ним
`Analyst requested raw operations` — это регресс переноса подсказки в `user`-роль (см. выше): ломается именно второй
раунд `/ask`. Стоит прогнать проверку на живом API, прежде чем трогать лестницу.

**Rich-сообщения не отображаются или приходят простым текстом:** клиент или аккаунт не поддерживает rich messages
(Bot API 10.1+). Бот сам падает обратно на обычный HTML при 400; чтобы отключить попытки совсем, выставить
`RENDER_MODE=html` в Variables и перезапустить.

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

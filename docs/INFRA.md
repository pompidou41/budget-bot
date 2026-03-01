# Budget Bot — Infrastructure

## Architecture Overview

| Компонент       | Технология     | Назначение                                  |
| --------------- | -------------- | ------------------------------------------- |
| Process manager | PM2            | Автозапуск при ребуте, перезапуск при краше |
| CI/CD           | GitHub Actions | Авто-деплой на push в main                  |
| Логи            | PM2 logs       | Логи процесса через `pm2 logs`              |
| Секреты         | GitHub Secrets | Источник правды для всех env-переменных     |

---

## Host Environment

- **Сервер**: Aeza VPS, Ubuntu 24.04
- **Пользователь**: `work`
- **Node.js**: 24 LTS via Homebrew (`/home/linuxbrew/.linuxbrew/opt/node@24/bin/node`)
- **yarn**: via Corepack
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

- `~/.pm2/logs/budget-bot-out.log` — stdout (pino JSON)
- `~/.pm2/logs/budget-bot-error.log` — stderr

---

## Деплой

### Автоматический (GitHub Actions)

При каждом пуше в ветку `main`:

1. GitHub Actions подключается по SSH к хосту
2. Записывает `.env` из GitHub Secrets
3. Запускает `scripts/deploy.sh`

Workflow: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)

### Ручной (с хоста)

```bash
cd /home/work/projects/budget-bot
bash scripts/deploy.sh
```

Скрипт: [`scripts/deploy.sh`](../scripts/deploy.sh)

Предполагает, что `.env` уже существует на хосте.

---

## Environment Variables

**Источник правды**: GitHub Secrets (Settings → Secrets and variables → Actions).

Файл на хосте: `/home/work/projects/budget-bot/.env` (права 600, не в git).

| Переменная                     | Описание                                             |
| ------------------------------ | ---------------------------------------------------- |
| `BOT_TOKEN`                    | Токен от @BotFather                                  |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Email сервисного аккаунта Google                     |
| `GOOGLE_PRIVATE_KEY`           | Приватный PEM-ключ сервисного аккаунта               |
| `ADMIN_USER_ID`                | (опционально) Telegram user ID администратора        |
| `LOG_LEVEL`                    | Уровень логов: `fatal`/`error`/`warn`/`info`/`debug` |

**SQLite база данных**: `data/budget-bot.db` — хранит пользователей (telegram_id → sheet_id, категории). Директория `data/` создаётся автоматически при запуске (скрипт деплоя также создаёт её через `mkdir -p`).

**Важно про `GOOGLE_PRIVATE_KEY`**: в GitHub Secret и в файле `.env` ключ должен быть записан как **одна строка** с `\n` литералами (как в `.env.example`). `node --env-file` автоматически разворачивает `\n` в реальные переносы строк.

### Синхронизация env между машинами

```bash
# Отправить локальный .env на хост (разовая операция или при изменении)
scp -P 22 .env work@HOST:/home/work/projects/budget-bot/.env

# Скачать .env с хоста локально
scp -P 22 work@HOST:/home/work/projects/budget-bot/.env .env
```

---

## GitHub Secrets

Настроить в: GitHub → репозиторий → Settings → Secrets and variables → Actions → New repository secret

| Secret                         | Значение                                             |
| ------------------------------ | ---------------------------------------------------- |
| `SSH_HOST`                     | IP-адрес Aeza VPS                                    |
| `SSH_USER`                     | `work`                                               |
| `SSH_PORT`                     | `22` (или кастомный порт из sshd_config)             |
| `SSH_PRIVATE_KEY`              | Приватный ed25519-ключ для деплоя (создать отдельно) |
| `BOT_TOKEN`                    | —                                                    |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | —                                                    |
| `GOOGLE_PRIVATE_KEY`           | —                                                    |
| `ADMIN_USER_ID`                | (опционально) — Telegram user ID администратора      |
| `LOG_LEVEL`                    | `info`                                               |

**Удалить старые секреты** (больше не используются): `GOOGLE_SHEETS_ID`, `ALLOWED_USER_ID`.

---

## Initial Setup (первый запуск на хосте)

Выполнить один раз на Aeza VPS:

```bash
# 1. Проверить путь к node (Homebrew on Linux)
which node   # ожидается: /home/linuxbrew/.linuxbrew/opt/node@24/bin/node

# 2. Установить PM2 глобально
yarn global add pm2
# или: npm install -g pm2

# 3. Склонировать / обновить репозиторий
git clone https://github.com/<user>/budget-bot.git /home/work/projects/budget-bot
# или, если уже склонирован:
cd /home/work/projects/budget-bot && git pull origin main

# 4. Создать .env на хосте
# Скопировать с локальной машины:
#   scp -P 22 .env work@HOST:/home/work/projects/budget-bot/.env
# или создать вручную:
nano /home/work/projects/budget-bot/.env
chmod 600 /home/work/projects/budget-bot/.env

# 5. Первая сборка
cd /home/work/projects/budget-bot
export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
yarn install --frozen-lockfile
yarn build

# 6. Запустить бота через PM2
pm2 start ecosystem.config.cjs
pm2 status   # → budget-bot: online

# 7. Настроить автозапуск PM2 при ребуте
pm2 startup  # выведет команду — выполнить её с sudo!
pm2 save     # сохранить список процессов

# 8. Создать SSH-ключ для GitHub Actions (отдельный от личного ключа)
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions_deploy -N ""
cat ~/.ssh/github_actions_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Вывести приватный ключ — вставить в GitHub Secret SSH_PRIVATE_KEY:
cat ~/.ssh/github_actions_deploy
```

---

## Troubleshooting

**Бот не запускается:**

```bash
pm2 logs budget-bot --lines 50   # смотреть ошибки
pm2 show budget-bot              # статус и пути к логам
```

**Деплой завершился ошибкой в GitHub Actions:**

- Проверить вкладку Actions в GitHub — там полный лог
- Частые причины: неправильный SSH-ключ, `yarn.lock` не синхронизирован, ошибка TypeScript

**PM2 не находит процесс после ребута:**

```bash
pm2 startup   # повторить настройку автозапуска
pm2 save      # сохранить список процессов
```

**Проверить, что бот слушает Telegram:**

```bash
pm2 logs budget-bot --lines 10   # должно быть "Starting bot..."
```

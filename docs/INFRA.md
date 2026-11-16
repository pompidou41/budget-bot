# Infrastructure

## Architecture Overview

| Компонент       | Технология     | Назначение                                          |
| --------------- | -------------- | --------------------------------------------------- |
| Запуск          | Docker Compose | Контейнер `budget-bot`, `restart: unless-stopped`, автозапуск вместе с Docker |
| Деплой          | `scripts/deploy-docker.sh` | Сборка образа на Mac, передача по SSH, откат при сбое; GitHub Actions не используется для деплоя |
| CI              | GitHub Actions | typecheck/lint/test на push в main (`.github/workflows/check.yml`) |
| Логи            | `docker logs`  | pino JSON в stdout, ротация json-file 10 МБ × 3     |
| Секреты         | `/srv/budget-bot/app.env` | Файл на хосте (root, 0600), источник правды       |
| Внешние API     | Google Sheets, OpenRouter, Groq, Telegram | Таблица, AI-разбор, расшифровка голоса |
| Рендер картинок | `@resvg/resvg-js` + Inter | PNG-тепловая карта для `/report` и «Итогов», в процессе бота |

---

## Host Environment

- **Сервер**: netcup (Docker Compose), раскладка хоста — в репозитории ops, `hosts/netcup/README.md`.
  Раньше бот жил на Aeza VPS под PM2 (пользователь `work`); перенос описан ниже, PM2 больше не используется
- **Файлы на хосте**: `/srv/budget-bot/compose.yml` (из ops, `hosts/netcup/srv/budget-bot/compose.yml`),
  `tag.env` (тег образа, пишет деплой), `app.env` (секреты, root 0600), `data/` (1104:1104, 0700)
- **Контейнер**: `node:24-bookworm-slim`, пользователь UID/GID 1104 (у каждого приложения на хосте свой UID),
  `read_only`, `cap_drop: ALL`, `no-new-privileges`, память 256 МБ, `init: true`, SIGTERM → `bot.stop()` (grace 20 с)
- **Рендер картинок**: `@resvg/resvg-js@2.6.2` — нативный N-API-модуль с **готовыми бинарниками** для glibc
  (`linux-x64-gnu` ставится вместе с `yarn install`); образ собирается под `linux/amd64`. Шрифты лежат в репозитории:
  `assets/fonts/Inter-Regular.ttf`, `Inter-SemiBold.ttf` (SIL OFL 1.1, `assets/fonts/OFL.txt`); системные шрифты resvg
  не читает. Сборка образа падает, если нативный модуль не поставился; картинки рисуют и тесты в CI

---

## Управление контейнером

```bash
cd /srv/budget-bot
docker compose --env-file tag.env ps                 # статус и health
docker compose --env-file tag.env logs -f --tail 100 # логи
docker compose --env-file tag.env restart bot        # перезапуск (SIGTERM → bot.stop())
docker compose --env-file tag.env stop bot           # остановить
```

Healthcheck: у бота нет health-эндпойнта. Если задан `MEMO_API_TOKEN`, проверка ходит на внутренний API и ждёт 401
(API стартует после загрузки таблицы), без токена остаётся только проверка живости процесса. Падение процесса
ловит `restart: unless-stopped`, неудачный старт — `deploy-docker.sh` (`--wait` и проверка счётчика рестартов).

---

## Деплой

С Mac, из чистого дерева (GitHub Actions недоступен, образ едет по SSH без registry):

```bash
scripts/deploy-docker.sh [--host netcup] [--allow-dirty]
```

Скрипт собирает `linux/amd64`-образ `budget-bot:<sha>`, грузит его на хост (`docker save | ssh … docker load`), пишет
тег в `/srv/budget-bot/tag.env`, делает `docker compose up -d --wait` и проверяет, что контейнер жив после паузы.
При сбое возвращает прошлый тег; хранит три последних образа; `flock` не даёт запустить два деплоя сразу.
Секреты деплой не трогает: менять их нужно в `/srv/budget-bot/app.env` и перезапускать контейнер.

### Перенос с Aeza (разово, порядок важен)

Один токен бота нельзя опрашивать с двух хостов (Telegram вернёт 409), поэтому старый бот останавливается первым.

```bash
# 1. Aeza: остановить бота (под ops)
sudo -u work pm2 stop budget-bot
# 2. Скопировать состояние и .env на netcup (через свою машину, секреты не печатать)
ssh aeza 'sudo tar -C /home/work/projects/budget-bot -cf - data .env' | ssh netcup 'tar -C /srv/budget-bot -xf -'
# 3. netcup: права. .env становится app.env
ssh netcup 'cd /srv/budget-bot && mv .env app.env && chown root:root app.env && chmod 600 app.env \
  && chown -R 1104:1104 data && chmod 700 data'
# 4. Положить compose.yml из ops в /srv/budget-bot/, затем с Mac:
scripts/deploy-docker.sh
# 5. Проверить: docker compose logs (Bot started), написать боту /last
# 6. Только после успеха — убрать PM2 на Aeza
sudo -u work pm2 delete budget-bot && sudo -u work pm2 save
sudo systemctl disable --now pm2-work && sudo npm rm -g pm2
```

memo-bot переезжает на netcup вместе с ботом: на Aeza он перестанет достучаться до API. Каталог `/home/work/projects/budget-bot` на Aeza удалять
после нескольких дней работы на netcup; откат — `pm2 start`, но тогда останови контейнер на netcup.

---

## Environment Variables

**Источник правды**: `/srv/budget-bot/app.env` на хосте (root, права 600, не в git), подключается как `env_file` compose.

| Переменная                     | Обяз. | Описание                                                        |
| ------------------------------ | ----- | --------------------------------------------------------------- |
| `BOT_TOKEN`                    | да    | Токен от @BotFather                                             |
| `OWNER_TELEGRAM_ID`            | да    | Telegram user ID владельца; все остальные апдейты игнорируются |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | да    | Email сервисного аккаунта Google                                |
| `GOOGLE_PRIVATE_KEY`           | да    | Приватный PEM-ключ сервисного аккаунта                          |
| `OPENROUTER_API_KEY`           | да    | Ключ OpenRouter (AI-разбор текста и картинок)                   |
| `GROQ_API_KEY`                 | да    | Ключ Groq (расшифровка голосовых)                               |
| `SPREADSHEET_ID`               | нет   | ID таблицы; по умолчанию «Расходы/доходы» v2                    |
| `OPENROUTER_MODEL`             | нет   | По умолчанию `google/gemini-3.8-flash`                          |
| `OPENROUTER_ANALYST_MODEL`     | нет   | Модель для `/ask` и `/review`, в GitHub Variables — `anthropic/claude-sonnet-5`; пусто — берётся `OPENROUTER_MODEL`. Для `anthropic/*` включается reasoning |
| `GROQ_STT_MODEL`               | нет   | По умолчанию `whisper-large-v3-turbo`                           |
| `BOT_TIMEZONE`                 | нет   | По умолчанию `Europe/Moscow`                                    |
| `RENDER_MODE`                  | нет   | `rich` (по умолчанию) или `html` — откат на обычный HTML-рендер  |
| `MEMO_API_TOKEN`               | нет   | Общий секрет для memo-bot (≥ 24 символов). Не задан — внутренний API выключен. Тот же токен лежит в `.env` memo-bot как `BUDGET_API_TOKEN` |
| `MEMO_API_PORT`                | нет   | Порт внутреннего API, по умолчанию `8787`; в Docker — только во внутренней сети `memo-budget` |
| `LOG_LEVEL`                    | да    | `fatal`/`error`/`warn`/`info`/`debug`/`trace`                   |

Пустое значение необязательной переменной = значение по умолчанию.

**Состояние на диске**: `data/journal.json` — последние 50 строк, записанных ботом (для `/undo`);
`data/settings.json` — настройки из `/settings` (счёт по умолчанию, заметки для ИИ, «Итоги недели»; старые алиасы
переносятся в заметки автоматически при чтении);
`data/drafts.json` — незавершённые черновики (TTL 24 ч);
`data/imports.json` — сессии импорта выписок за сводкой (3 дня, не больше 5; хранят строки выписки и номера записанных строк для отмены);
`data/conversations.json` — треды `/ask`, привязанные к сообщению-ответу (история 24 ч);
`data/recap.json` — `{lastSent, sentAt, messageId}` последних отправленных «Итогов», чтобы перезапуск в окне 10:00–10:00
следующего дня не прислал их второй раз (нет файла — считается, что ничего не отправлено; удалить файл = разрешить
повторную отправку в пределах окна).
Черновики и треды хранятся на диске, чтобы reply на сообщение бота продолжал работать после перезапуска.
Директория `data/` — bind-mount `/srv/budget-bot/data` в `/app/data`, переживает деплой; все файлы пишутся атомарно (temp + rename).
Больше бот ничего на диске не хранит.

**Важно про `GOOGLE_PRIVATE_KEY`**: в GitHub Secret и в файле `.env` ключ должен быть записан как **одна строка** с `\n`
литералами (как в `.env.example`). `node --env-file` автоматически разворачивает `\n` в реальные переносы строк.

**Доступ к таблице**: сервисный аккаунт должен быть **редактором** таблицы v2 (Поделиться → email сервисного аккаунта).
Проверка с локальной машины: `yarn check-sheet`. Бэкап перед правками структуры таблицы: `yarn backup-sheet`
(формулы и значения всех листов в `data/backups/<время>/`) плюс «Файл → Создать копию» в Google Sheets.

**Внутренний API для memo-bot.** Если `MEMO_API_TOKEN` задан, процесс дополнительно слушает `127.0.0.1:MEMO_API_PORT`
(см. «Внутренний API для memo-bot» в [`ARCHITECTURE.md`](ARCHITECTURE.md)). Наружу порт не открывать (ни в фаерволе, ни через
reverse proxy). На netcup API доступен только во внутренней Docker-сети `memo-budget` (`docker network create --internal memo-budget`,
один раз): контейнер слушает `0.0.0.0` (`MEMO_API_HOST` задаёт compose), memo-bot ходит на `http://budget-bot:8787`, на хост порт
не публикуется. Токен и порт задаются в `app.env`. Проверка изнутри контейнера (токен не печатается):
`docker compose -f /srv/budget-bot/compose.yml exec bot node -e "fetch('http://127.0.0.1:8787/v1/balances',{headers:{Authorization:'Bearer '+process.env.MEMO_API_TOKEN}}).then(r=>console.log(r.status))"`.

### Изменение env

Правка `/srv/budget-bot/app.env` на хосте (root), затем `docker compose --env-file tag.env up -d --force-recreate bot`.
Формат — как `.env.example`; `GOOGLE_PRIVATE_KEY` одной строкой с `\n` (код сам разворачивает литералы).

---

## Переход с v1 (разово)

1. Выдать сервисному аккаунту доступ редактора к таблице v2.
2. Добавить в `app.env` `OWNER_TELEGRAM_ID`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`.
3. После первого деплоя в `data/` можно удалить `data/budget-bot.db*` (SQLite v1 больше не читается).

---

## Troubleshooting

**Бот не запускается:**

```bash
docker compose --env-file tag.env logs --tail 50 bot   # в /srv/budget-bot
docker compose --env-file tag.env ps                    # статус и health
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

**В логах `Provider did not honour the response format, stepping down`:** это не ошибка. ZDR-маршрутизация увела запрос
на эндпоинт, который отказал в формате (400) или ответил прозой вместо JSON (так делают и Vertex, и Bedrock),
и `completeJson` спустился на ступень ниже — `json_object`, затем схема прямо в промпте. Ответ всё равно валидируется zod. Постоянные срабатывания на
первой ступени означают лишь, что для этой модели strict-схема недоступна.

Если же в логах `Failed to answer a finance question` с `returned non-JSON content`, а перед ним
`Analyst requested raw operations` — это регресс переноса подсказки в `user`-роль (см. выше): ломается именно второй
раунд `/ask`. Стоит прогнать проверку на живом API, прежде чем трогать лестницу.

**Нет «Итогов» 1/9/17/25 числа:** смотреть `docker compose logs bot | grep -i recap` — `Recap sent` или `Failed to send recap,
will retry` (повтор каждые 15 минут в течение суток). Проверить `/settings` (переключатель «🗓 Итоги недели») и
`data/recap.json`. Получить сводку вручную можно командой `/recap`; она состояния не меняет.

**Rich-сообщения не отображаются или приходят простым текстом:** клиент или аккаунт не поддерживает rich messages
(Bot API 10.1+). Бот сам падает обратно на обычный HTML при 400; чтобы отключить попытки совсем, выставить
`RENDER_MODE=html` в Variables и перезапустить.

**Деплой откатился:** смотреть вывод `deploy-docker.sh` и `docker compose logs bot` на хосте. Частые причины:
нет или не читается `app.env`, не задана обязательная переменная (`Invalid environment variables`), `data/` не принадлежит
1104:1104 (ошибки `EACCES` в логе), второй хост опрашивает тот же токен (Telegram 409).

**Проверить, что бот слушает Telegram:**

```bash
docker compose --env-file tag.env logs --tail 10 bot   # "Starting bot..." и "Bot started"
```

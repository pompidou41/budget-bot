# Budget Bot — Стек и план работ

## Стек технологий

| Компонент         | Технология                        | Почему                                              |
| ----------------- | --------------------------------- | --------------------------------------------------- |
| Runtime           | Node.js 24 LTS                    | Стабильная LTS, нативные `fetch`/`FormData`         |
| Язык              | TypeScript 5.x (strict)           | Type safety                                         |
| Telegram Bot      | grammY                            | TS-first, long polling                              |
| Google Sheets     | googleapis                        | Официальный SDK, сервисный аккаунт                  |
| AI-разбор         | OpenRouter → Gemini Flash         | Текст и картинки, strict JSON schema, дёшево        |
| Голос             | Groq Whisper large v3 turbo       | Быстрая и дешёвая расшифровка русского              |
| Валидация         | zod                               | env и ответы модели                                 |
| Логирование       | pino                              | Structured logging                                  |
| Тесты             | vitest                            | Чистые функции domain/draft-actions, без сети       |
| Пакетный менеджер | yarn classic (lockfile v1)        | Совпадает с сервером                                |
| Линтинг           | ESLint + Prettier                 | Format on save в VS Code                            |

## Таблица

Структура — [`SHEET_V2.md`](SHEET_V2.md). Бот пишет только `Операции!A:K`, читает «Счета» и «Categories».
Аналитика — в листах таблицы («Дашборд», «Категории по месяцам»).

## План работ

### v1 — архив

Мультиюзер с регистрацией и SQLite, шаблонный парсер «Категория Сумма Комментарий», синхронизация «Сводки»,
отчёты в боте. Удалено при переходе на таблицу v2 (2026-09).

### v2 — AI-ввод под таблицу v2

- [x] Однопользовательский режим (`OWNER_TELEGRAM_ID`), удаление регистрации/SQLite/«Сводки»/отчётов
- [x] Модель `Operation` под `Операции!A:K`, валидация по справочникам «Счета»/«Categories»
- [x] Запись в первую свободную строку под мьютексом, проверка шапки при старте
- [x] Черновик с кнопками, правка ответом через AI
- [x] AI-разбор текста (несколько операций, алиасы счетов, счёт не угадывается)
- [x] Голосовые (Groq) и фото/скриншоты (Gemini vision)
- [x] `/add` — мастер под v2, `/undo` по журналу с проверкой содержимого, `/balance`, `/refresh`
- [x] Обработчик ошибок с ответом пользователю
- [x] CI: typecheck/lint/test перед деплоем
- [ ] Прогон сценариев на копии таблицы с dev-ботом
- [ ] Секреты в GitHub, доступ сервисного аккаунта к таблице v2, деплой

### v2.2 — `/ask`: вопросы про свои финансы

- [x] `analytics/dataset.ts` — история «Операции» `A2:T` с кэшем, типизированные `Txn`
- [x] `analytics/queries.ts` — агрегаты: категория×месяц, регулярные траты по медиане, бюджет месяца, выборка строк
- [x] `analytics/digest.ts` — весь посчитанный контекст одним блоком промпта
- [x] `ai/analyst.ts` — ответ структурой + раунды «запросить сырые строки → ответить» (до 3)
- [x] `domain/answer.ts` — рендер ответа в HTML: экранирование, столбики динамики, обрезка по блокам
- [x] `/ask` и продолжение разговора ответом (reply), история 30 мин
- [ ] Прогон вопросов на копии таблицы с dev-ботом

### v2.3 — reply перестаёт теряться

- [x] `state/conversations.ts` — треды `/ask` в `data/conversations.json`, история 24 ч
- [x] Якорь живёт дольше истории: reply на старый ответ начинает новый вопрос, а не черновик расхода
- [x] Черновики в `data/drafts.json`, сброс на диск middleware после каждого апдейта (`UX-002`)
- [x] `bot/voice.ts` — общий разбор голосового; голосовой reply уходит в `/ask`, а не в парсер операций
- [x] Кнопка «Задать как вопрос» под сообщением, где операций не нашлось
- [ ] Проверка на dev-боте: рестарт процесса между вопросом и ответом

### v2.4 — `/report`: траты по категориям и периодам

- [x] `analytics/queries.ts` — ISO-недели (`weekKey`, `periodLabel`, `recentPeriods`), матрица категория×период
- [x] `analytics/digest.ts` — недельный блок (12 недель) в промпте `/ask`
- [x] `domain/report.ts` — состояние экрана, кодек `callback_data` (маска категорий base36), рендер таблиц
- [x] `/report` с переключателями: недели/месяцы, длина окна, разовые, выбор категорий
- [ ] Проверка на dev-боте: реальный лимит колонок в `<table>`, настройка `MAX_TABLE_PERIODS`

### v2.5 — rich messages

- [x] grammY 1.46 (Bot API 10.3)
- [x] `bot/rich.ts` — `sendView`/`editView` с деградацией rich → HTML → plain text
- [x] `RENDER_MODE=rich|html` в env
- [x] `renderAnswerRich`, `renderBalanceRich`, `renderReportRich`
- [ ] Проверка на dev-боте: как rich рендерится в клиенте владельца
- [ ] Опционально: `sendRichMessageDraft` вместо «⏳ Считаю…» (стриминг черновика ответа)

### v2.6 — аналитик на Claude Sonnet 5

- [x] Лестница форматов в `ai/openrouter.ts`: strict schema → `json_object` → схема в промпте
- [x] `OPENROUTER_ANALYST_MODEL=anthropic/claude-sonnet-5` в `.env.example` и документации
- [x] Выставить переменную в GitHub Variables (и прокинуть её в `.env` в `deploy.yml` — раньше не прокидывалась)
- [ ] Сравнить ответы с Gemini на реальных вопросах, проверить по логам, какая ступень сработала

### v2.7 — `/review`: разбор финансов от ИИ

- [x] `analytics/signals.ts` — период против обычного, чаще/дороже, привычка/всплеск, новые траты, крупные траты, прогноз
- [x] `domain/review.ts` — `Review` данными, цифры из сигналов, рендер rich и HTML
- [x] `ai/analyst.ts` — `review()`, промпт «для обычного человека», тот же тон и сигналы в `/ask`
- [x] Reasoning через `reasoning.max_tokens` для `anthropic/*`; схема всегда в промпте, спуск на ответ-не-JSON
- [x] `/review` и `/ask` в фоне (`inBackground`), чтобы не блокировать ввод операций
- [ ] Проверка на dev-боте на реальных данных: насколько полезны инсайты, не слишком ли длинно

Дальше — [`BACKLOG.md`](BACKLOG.md).

## Структура проекта

```
budget-bot/
├── .github/workflows/deploy.yml — CI: проверки → SSH-деплой на push в main
├── docs/                        — ARCHITECTURE, SHEET_V2, PRD, INFRA, BACKLOG, plans/
├── scripts/
│   ├── deploy.sh                — деплой на хосте
│   └── check-sheet.ts           — read-only проверка таблицы (`yarn check-sheet`)
├── src/
│   ├── ai/                      — OpenRouter (разбор и аналитика), Groq (голос), промпты и схемы
│   ├── analytics/               — история операций, агрегаты, дайджест чисел для /ask
│   ├── bot/
│   │   ├── handlers/            — commands, draft (кнопки), input (текст/голос/фото)
│   │   ├── drafts.ts            — хранилище черновиков
│   │   ├── draft-actions.ts     — переходы черновика (чистые функции)
│   │   ├── wizard.ts            — шаги /add
│   │   ├── render.ts, keyboards.ts
│   │   ├── guard.ts             — только владелец
│   │   └── index.ts             — сборка бота, обработчик ошибок
│   ├── config/                  — env (zod), алиасы счетов
│   ├── domain/                  — Operation, validate, даты, карточка, остатки
│   ├── sheets/                  — справочники, запись/отмена, проверка шапки
│   ├── state/journal.ts         — журнал записей для /undo
│   ├── logger.ts
│   └── index.ts                 — entry point
├── test/                        — vitest
├── ecosystem.config.cjs         — PM2
└── .env.example
```

## Запуск

### Локальная разработка

1. `cp .env.example .env` — заполнить переменные (dev-токен бота, свой `OWNER_TELEGRAM_ID`)
2. Сделать копию таблицы (Файл → Создать копию), выдать сервисному аккаунту доступ редактора, указать её `SPREADSHEET_ID`
3. `yarn check-sheet` — справочники читаются, шапка «Операций» совпадает
4. `yarn dev` — запуск в watch-режиме

### Продакшн (Aeza VPS)

Подробно: [`INFRA.md`](INFRA.md). CI/CD: push в `main` → GitHub Actions (проверки) → SSH → `pm2 reload budget-bot`.

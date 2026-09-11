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
│   ├── ai/                      — OpenRouter (разбор), Groq (голос), промпт и схема ответа
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

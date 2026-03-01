# Budget Bot — Стек и план работ

## Стек технологий

| Компонент         | Технология                    | Почему                               |
| ----------------- | ----------------------------- | ------------------------------------ |
| Runtime           | Node.js 24 LTS                | Стабильная LTS версия                |
| Язык              | TypeScript 5.x                | Type safety                          |
| Telegram Bot      | grammY                        | Современный, TS-first, open-source   |
| Google Sheets     | googleapis                    | Официальный SDK от Google            |
| AI-отчёты         | Google Gemini API (free tier) | Бесплатно, 15 RPM                    |
| Графики           | QuickChart.io                 | Генерация графиков по URL            |
| Планировщик       | node-cron                     | Ежемесячные отчёты, проверка лимитов |
| Валидация         | zod                           | Валидация env и входных данных       |
| Логирование       | pino                          | Быстрый structured logging           |
| Пакетный менеджер | yarn                          | —                                    |
| Линтинг           | ESLint + Prettier             | Format on save в VS Code             |

## Структура Google Sheets

**Лист "Сводка"** — сводная таблица по неделям/категориям (категории по строкам, недели по столбцам). Бот:

- читает категории из этого листа при регистрации
- записывает суммы транзакций в ячейки с формулами вида `=1500+3000` при подтверждении операции

**Лист "Операции"** — бот пишет сюда:

| Date       | Type   | Category | Amount | Comment   |
| ---------- | ------ | -------- | ------ | --------- |
| 2026-02-16 | Расход | Продукты | 1500   | Пятёрочка |
| 2026-02-16 | Доход  | Зарплата | 80000  | —         |

## Формат сообщений

```
Категория Сумма Комментарий
```

Примеры:

- `Продукты 1500 Пятёрочка`
- `Такси 350`
- `Зарплата 80000`

Комментарий — необязателен.

## План работ

### Фаза 1 — Скелет проекта ✅

- [x] Инициализация проекта (yarn, TypeScript, ESLint, Prettier)
- [x] VS Code config для format on save
- [x] grammY бот с базовыми командами (`/start`, `/help`, `/menu`, `/categories`, `/undo`)
- [x] Google Sheets API подключение (сервисный аккаунт)
- [x] Конфиг через `.env` + валидация через zod
- [x] Парсинг сообщений и запись транзакций
- [x] Inline-кнопки подтверждения (сохранить / изменить категорию / отмена)
- [x] Саммари за период (неделя / месяц / прошлый месяц / всё время)

### Мульти-юзер ✅

- [x] SQLite хранилище пользователей (better-sqlite3) — telegram_id → sheet_id + категории
- [x] Регистрационный флоу: `/start` → email сервисного аккаунта → ссылка на таблицу → парсинг категорий из "Сводка"
- [x] Проверка доступа к Google Sheet при регистрации
- [x] Per-user категории: читаются из листа "Сводка" (маркеры "расходы итого:" / "доход итого:")
- [x] Все хендлеры используют `ctx.user.sheetId` и `ctx.user.*Categories`
- [x] Переименование: `TRANSACTIONS_SHEET = 'Операции'`

### Фаза 2 — Графики и улучшение саммари

- [ ] Line chart трат по категориям за период
- [ ] Pie chart распределения расходов
- [ ] Отправка графиков как фото в чат
- [ ] Кнопки выбора типа графика

### Фаза 3 — AI-отчёты

- [ ] Интеграция с Gemini API (free tier)
- [ ] Команда/кнопка для генерации отчёта за месяц
- [ ] Анализ паттернов трат + рекомендации
- [ ] Ежемесячная автоматическая отправка (node-cron)

### Инфраструктура ✅

- [x] Хостинг: Aeza VPS, Ubuntu 24.04
- [x] Process manager: PM2 (`ecosystem.config.cjs`)
- [x] CI/CD: GitHub Actions — push в `main` → SSH-деплой → `pm2 reload`
- [x] Документация: [`docs/INFRA.md`](INFRA.md)

### Фаза 4 — Доработки

- [x] Синхронизация "Операции" → "Сводка": при подтверждении транзакции бот обновляет формулу в нужной ячейке "Сводки"
- [ ] Реверс "Сводки" при /undo (`FEAT-014`)
- [ ] Улучшение парсинга сообщений
- [ ] Дополнительные фичи по необходимости

## Структура проекта

```
budget-bot/
├── .github/workflows/deploy.yml — CI/CD: авто-деплой на push в main
├── .vscode/settings.json        — format on save
├── .claude/settings.local.json  — claude settings
├── docs/
│   ├── plans/                   — планы Claude
│   ├── INFRA.md                 — инфраструктура, деплой, PM2
│   ├── PLAN.md                  — планы по проекту (фазы)
│   ├── PRD.md                   — Product Requirements Document
│   └── BACKLOG.md               — бэкложные задачи (fixes, bugs, etc)
├── scripts/
│   └── deploy.sh                — ручной деплой на хосте
├── src/
│   ├── bot/
│   │   ├── commands/            — /start, /help, /menu, /categories, /summary, /undo
│   │   ├── handlers/            — парсинг сообщений, транзакции, саммари, регистрация
│   │   ├── keyboards/           — inline-кнопки
│   │   ├── middleware/auth.ts   — userMiddleware: загружает ctx.user из SQLite
│   │   ├── context.ts           — BotContext (extends grammY Context + user?: UserRecord)
│   │   └── index.ts             — сборка бота
│   ├── sheets/                  — Google Sheets API + парсер "Сводка" + проверка доступа
│   ├── db/                      — SQLite (better-sqlite3): users CRUD
│   ├── config/                  — env-валидация, дефолтные категории
│   ├── ai/                      — Gemini (Фаза 3)
│   ├── analytics/               — Графики (Фаза 2)
│   ├── scheduler/               — Cron-задачи (Фаза 3-4)
│   ├── logger.ts                — pino
│   └── index.ts                 — entry point
├── CLAUDE.md                    — документация проекта для Claude
├── ecosystem.config.cjs         — PM2 конфиг (process manager)
├── .env.example
├── .prettierrc
├── eslint.config.js
├── tsconfig.json
└── package.json
```

## Запуск

### Локальная разработка

1. `cp .env.example .env` — заполнить переменные
2. Создать бота через @BotFather → получить токен
3. Создать Google Service Account → получить email и ключ
4. `yarn dev` — запуск в watch-режиме
5. Отправить `/start` боту → зарегистрироваться (расшарить таблицу с email сервисного аккаунта)

### Продакшн (Aeza VPS)

Подробная инструкция: [`docs/INFRA.md`](INFRA.md).

```bash
yarn build              # компиляция
pm2 start ecosystem.config.cjs  # запуск через PM2
pm2 startup && pm2 save         # автозапуск при ребуте
```

CI/CD: push в `main` → GitHub Actions → SSH → `pm2 reload budget-bot`.

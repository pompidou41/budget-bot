# Budget Bot — CLAUDE.md

Telegram-бот для учёта личных финансов на TypeScript + grammY + Google Sheets.
Документация проекта: [`docs/PLAN.md`](docs/PLAN.md), [`docs/PRD.md`](docs/PRD.md), [`docs/BACKLOG.md`](docs/BACKLOG.md), [`docs/INFRA.md`](docs/INFRA.md).

---

## Быстрый старт

```bash
yarn dev          # запуск в watch-режиме (tsx)
yarn build        # компиляция TypeScript → dist/
yarn start        # запуск скомпилированной версии
yarn lint         # проверка ESLint
yarn lint:fix     # автоисправление ESLint
yarn format       # форматирование Prettier
yarn typecheck    # проверка типов без компиляции
```

Перед запуском скопировать `.env.example` → `.env` и заполнить переменные.

---

## Архитектура

```
src/
├── index.ts              — точка входа: initDb(), initSheets(), createBot()
├── logger.ts             — pino с pino-pretty
├── config/
│   ├── env.ts            — Zod-схема переменных окружения
│   ├── categories.ts     — DEFAULT_EXPENSE_CATEGORIES (24), DEFAULT_INCOME_CATEGORIES (4)
│   └── index.ts
├── db/
│   ├── index.ts          — initDb() / getDb() — синглтон SQLite (better-sqlite3)
│   ├── schema.ts         — createTables(): DDL таблицы users
│   ├── types.ts          — интерфейс UserRecord
│   └── users.ts          — CRUD: findUser, createUser, updateUser, deleteUser
├── sheets/
│   ├── client.ts         — JWT-аутентификация через сервисный аккаунт
│   ├── transactions.ts   — CRUD: appendTransaction, getTransactions, deleteLastTransaction
│   ├── access-check.ts   — verifySheetAccess(), extractSheetIdFromUrl()
│   ├── brief-parser.ts   — parseBriefCategories() — читает категории из листа "Сводка"
│   └── index.ts
└── bot/
    ├── index.ts          — createBot() — сборка бота, Bot<BotContext>
    ├── context.ts        — BotContext: extends Context + user?: UserRecord
    ├── commands/         — /start, /help, /menu, /categories, /summary, /undo
    ├── handlers/
    │   ├── message-parser.ts  — парсинг "Категория Сумма Комментарий" (категории как параметры)
    │   ├── transaction.ts     — флоу подтверждения/изменения транзакции
    │   ├── summary.ts         — саммари за период с агрегацией
    │   └── registration.ts   — стейт-машина регистрации (Map<userId, RegistrationState>)
    ├── keyboards/index.ts     — inline-кнопки (включая registrationAddedKeyboard, categoriesConfirmKeyboard)
    └── middleware/auth.ts     — userMiddleware: findUser() → ctx.user, всегда вызывает next()
```

**Пустые модули для будущих фаз:** `src/ai/`, `src/analytics/`, `src/scheduler/`

---

## Статус разработки

**Текущая фаза: Мульти-юзер — завершена.** Следующая: Фаза 2 (графики).

| Фаза | Что                                              | Статус |
| ---- | ------------------------------------------------ | ------ |
| 1    | Запись транзакций, подтверждение, /undo, саммари | ✅     |
| —    | Инфраструктура: PM2 + GitHub Actions CI/CD       | ✅     |
| —    | Мульти-юзер: SQLite + регистрация + per-user     | ✅     |
| 2    | Графики (line/pie через QuickChart.io)           | 🔜     |
| 3    | AI-отчёты через Gemini API                       | 📋     |
| 4    | Лимиты по категориям                             | 📋     |
| 5    | Синхронизация листов                             | 📋     |

Детальный план: [`docs/PLAN.md`](docs/PLAN.md). Бэклог: [`docs/BACKLOG.md`](docs/BACKLOG.md).

---

## Ключевые паттерны

### BotContext

Все хендлеры используют `BotContext` вместо стандартного `Context`:

```typescript
interface BotContext extends Context {
  user?: UserRecord; // заполняется userMiddleware из SQLite
}
```

Если `ctx.user` есть — пользователь зарегистрирован. Каждый хендлер, требующий регистрации, сам проверяет `ctx.user`.

### Регистрация

Стейт-машина в `src/bot/handlers/registration.ts`:
- `awaiting_added` → `/start` → показывает email сервисного аккаунта
- `awaiting_sheet_url` → после нажатия "Добавил" → ждёт ссылку на таблицу
- `awaiting_categories_confirm` → после проверки доступа → ждёт подтверждения категорий

### UserRecord

```typescript
interface UserRecord {
  telegramId: number;
  sheetId: string;       // Google Sheet ID пользователя
  sheetUrl: string;
  expenseCategories: string[];
  incomeCategories: string[];
  categoriesSource: 'parsed' | 'default';
  registeredAt: string;
  updatedAt: string;
}
```

### Транзакция

```typescript
interface Transaction {
  date: string; // YYYY-MM-DD
  type: 'Расход' | 'Доход';
  category: string; // из ctx.user.expenseCategories или ctx.user.incomeCategories
  amount: number;
  comment: string; // пустая строка если нет
}
```

### Формат сообщения пользователя

```
Категория Сумма Комментарий
```

Примеры: `Продукты 1500 Пятёрочка`, `Такси 350`, `Зарплата 80000`.
Парсинг в [`src/bot/handlers/message-parser.ts`](src/bot/handlers/message-parser.ts).
Категории передаются как параметры: `parseTransactionMessage(text, expenseCategories, incomeCategories)`.

### Google Sheets

- Лист **"Операции"** — бот пишет и читает отсюда (у каждого пользователя своя таблица)
- Лист **"Сводка"** — бот читает категории из столбца A при регистрации
- Заголовки "Операции": `Date | Type | Category | Amount | Comment`
- Аутентификация через JWT (сервисный аккаунт Google)

### Состояние

- **Pending-транзакции**: в памяти (`Map<number, ParsedMessage>`)
- **Состояние регистрации**: в памяти (`Map<number, RegistrationState>`) — сбрасывается при рестарте
- **Пользователи**: SQLite `data/budget-bot.db` — персистентно

---

## Конвенции кода

- **ES-модули** (`"type": "module"` в package.json), NodeNext resolution
- **Строгий TypeScript**: strict, noUncheckedIndexedAccess, noImplicitReturns
- **Форматирование**: Prettier (single quotes, semi, trailing commas, printWidth 100)
- **Импорты**: всегда с расширением `.js` (NodeNext требует) → `import { foo } from './foo.js'`
- **Логирование**: только через `logger` из [`src/logger.ts`](src/logger.ts), не `console.log`
- **Переменные окружения**: только через `config` из [`src/config/index.ts`](src/config/index.ts), не `process.env`
- **Пакетный менеджер**: `yarn` (не npm, не pnpm)

---

## Известные баги (приоритет P0/P1)

Полный список: [`docs/BACKLOG.md`](docs/BACKLOG.md).

---

## Окружение

- **Node.js** ≥ 22.0.0 (использует `--env-file` флаг); на проде — Node.js 24 LTS
- **Переменные**: `BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ADMIN_USER_ID` (опц.), `LOG_LEVEL`
- **SQLite**: `data/budget-bot.db` (в .gitignore). Создаётся автоматически через `initDb()`.
- **Тестов нет** — покрытие планируется в будущем
- **CI/CD**: GitHub Actions — push в `main` → SSH-деплой на Aeza VPS. Подробнее: [`docs/INFRA.md`](docs/INFRA.md)
- **Process manager**: PM2 (`ecosystem.config.cjs`), автозапуск через `pm2 startup`

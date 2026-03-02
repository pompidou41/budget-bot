# Budget Bot — CLAUDE.md

Telegram-бот для учёта личных финансов на TypeScript + grammY + Google Sheets.
Документация проекта: [`docs/PLAN.md`](docs/PLAN.md), [`docs/PRD.md`](docs/PRD.md), [`docs/BACKLOG.md`](docs/BACKLOG.md), [`docs/INFRA.md`](docs/INFRA.md), [`docs/WSL_DEVELOPMENT.md`](docs/WSL_DEVELOPMENT.md).

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
│   ├── brief-updater.ts  — updateBriefCell() — обновляет ячейку в "Сводка" при добавлении транзакции
│   └── index.ts
└── bot/
    ├── index.ts          — createBot() — сборка бота, Bot<BotContext>
    ├── context.ts        — BotContext: extends Context + user?: UserRecord
    ├── commands/         — /start, /help, /menu, /categories, /summary, /undo (с диалогом подтверждения)
    ├── handlers/
    │   ├── message-parser.ts  — парсинг "Категория Сумма Комментарий" (категории как параметры)
    │   ├── transaction.ts     — флоу подтверждения/изменения транзакции
    │   ├── summary.ts         — отчёты: саммари (buildSummaryText), расходы (buildExpensesText),
    │   │                        доходы (buildIncomeText), последние записи (buildRecentText)
    │   ├── registration.ts    — стейт-машина регистрации (Map<userId, RegistrationState>)
    │   └── wizard.ts          — пошаговый wizard добавления операции (5 шагов)
    ├── keyboards/index.ts     — inline-кнопки; periodKeyboard(prefix) — общая фабрика периодов
    └── middleware/auth.ts     — userMiddleware + authGuardMiddleware (блокирует незарегистрированных)
```

**Пустые модули для будущих фаз:** `src/ai/`, `src/analytics/`, `src/scheduler/`

---

## Статус разработки

**Текущая фаза: Фаза 4 (UX-доработки) — завершена.** Следующая: Фаза 2 (графики).

| Фаза | Что                                              | Статус |
| ---- | ------------------------------------------------ | ------ |
| 1    | Запись транзакций, подтверждение, /undo, саммари | ✅     |
| —    | Инфраструктура: PM2 + GitHub Actions CI/CD       | ✅     |
| —    | Мульти-юзер: SQLite + регистрация + per-user     | ✅     |
| 4    | UX-доработки: меню, wizard, auth guard           | ✅     |
| —    | Багфиксы UX: раздельные отчёты, /undo с подтверждением, чистая регистрация | ✅ |
| 2    | Графики (line/pie через QuickChart.io)           | 🔜     |
| 3    | AI-отчёты через Gemini API                       | 📋     |
| 5    | Лимиты по категориям                             | 📋     |
| 6    | Синхронизация листов                             | 📋     |

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
  sheetId: string; // Google Sheet ID пользователя
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
- Лист **"Сводка"** — бот читает категории из столбца A при регистрации и записывает суммы транзакций в ячейки при подтверждении операции
  - Структура: строка 2 — Месяц, строка 3 — Неделя (1-8, 9-16, 17-24, 25-31)
  - Столбец A: названия категорий; столбец B: sparkline-графики
  - 4 цветовые секции: **Расходы** (синий), **Переводы** (жёлтый), **Доходы** (зелёный), **Состояние** (серый)
  - Каждая секция начинается итоговой строкой ("Расходы итого:", "Доход итого:", и т.д.) и строкой "Месяц" (итог за весь месяц)
  - Ячейки данных содержат формулы вида `=27600+3600+900` — каждое слагаемое = одна операция за период (неделю)
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

## Документирование изменений

**Обязательная документация** для изменений функций бота, бизнес-логики, инфраструктуры или архитектуры:

1. **Изменения функций бота**: обновить описание в [Архитектуре](#архитектура) если функция относится к основным модулям (например, добавлена новая команда, изменён флоу хендлера).
2. **Изменения интерфейсов/типов**: обновить описание типов в [Ключевых паттернах](#ключевые-паттерны) (например, если добавлено поле в `UserRecord` или `Transaction`).
3. **Изменения инфраструктуры**: обновить [`docs/INFRA.md`](docs/INFRA.md).
4. **Новые фазы/готовые фичи**: обновить таблицу [Статус разработки](#статус-разработки) в CLAUDE.md.
5. **Изменения состояния (state)**: если изменено управление состоянием в памяти или БД, обновить раздел [Состояние](#состояние).

---

## Известные баги (приоритет P0/P1)

Полный список: [`docs/BACKLOG.md`](docs/BACKLOG.md).

---

## Окружение

- **Локальная разработка**: Windows 11 + WSL2 (Ubuntu). Все команды выполняются внутри WSL.
- **Node.js** ≥ 22.0.0 (использует `--env-file` флаг); на проде — Node.js 24 LTS
- **Переменные**: `BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ADMIN_USER_ID` (опц.), `LOG_LEVEL`
- **SQLite**: `data/budget-bot.db` (в .gitignore). Создаётся автоматически через `initDb()`.
- **Тестов нет** — покрытие планируется в будущем
- **CI/CD**: GitHub Actions — push в `main` → SSH-деплой на Aeza VPS. Подробнее: [`docs/INFRA.md`](docs/INFRA.md)
- **Process manager**: PM2 (`ecosystem.config.cjs`), автозапуск через `pm2 startup`

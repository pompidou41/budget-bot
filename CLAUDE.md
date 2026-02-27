# Budget Bot — CLAUDE.md

Telegram-бот для учёта личных финансов на TypeScript + grammY + Google Sheets.
Документация проекта: [`docs/PLAN.md`](docs/PLAN.md), [`docs/PRD.md`](docs/PRD.md), [`docs/BACKLOG.md`](docs/BACKLOG.md).

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
├── index.ts              — точка входа: инициализация конфига, Sheets, бота
├── logger.ts             — pino с pino-pretty
├── config/
│   ├── env.ts            — Zod-схема для 6 переменных окружения
│   ├── categories.ts     — списки категорий расходов (24) и доходов (4)
│   └── index.ts
├── sheets/
│   ├── client.ts         — JWT-аутентификация через сервисный аккаунт
│   ├── transactions.ts   — CRUD: appendTransaction, getTransactions, deleteLastTransaction
│   └── index.ts
└── bot/
    ├── index.ts          — createBot() — сборка бота
    ├── commands/         — /start, /help, /menu, /categories, /summary, /undo
    ├── handlers/
    │   ├── message-parser.ts  — парсинг "Категория Сумма Комментарий"
    │   ├── transaction.ts     — флоу подтверждения/изменения транзакции
    │   └── summary.ts         — саммари за период с агрегацией
    ├── keyboards/index.ts     — определения inline-кнопок
    └── middleware/auth.ts     — авторизация по ALLOWED_USER_ID
```

**Пустые модули для будущих фаз:** `src/ai/`, `src/analytics/`, `src/scheduler/`

---

## Статус разработки

**Текущая фаза: 1 (MVP) — завершена.** Следующая: Фаза 2 (графики).

| Фаза | Что | Статус |
|------|-----|--------|
| 1 | Запись транзакций, подтверждение, /undo, саммари | ✅ |
| 2 | Графики (line/pie через QuickChart.io) | 🔜 |
| 3 | AI-отчёты через Gemini API | 📋 |
| 4 | Лимиты по категориям | 📋 |
| 5 | Docker, синхронизация листов | 📋 |

Детальный план: [`docs/PLAN.md`](docs/PLAN.md). Бэклог: [`docs/BACKLOG.md`](docs/BACKLOG.md).

---

## Ключевые паттерны

### Транзакция

```typescript
interface Transaction {
  date: string;      // YYYY-MM-DD
  type: 'Расход' | 'Доход';
  category: string;  // из EXPENSE_CATEGORIES или INCOME_CATEGORIES
  amount: number;
  comment: string;   // пустая строка если нет
}
```

### Формат сообщения пользователя

```
Категория Сумма Комментарий
```

Примеры: `Продукты 1500 Пятёрочка`, `Такси 350`, `Зарплата 80000`.
Парсинг в [`src/bot/handlers/message-parser.ts`](src/bot/handlers/message-parser.ts).

### Google Sheets

- Лист **"Transactions"** — бот пишет и читает отсюда
- Заголовки: `Date | Type | Category | Amount | Comment`
- Аутентификация через JWT (сервисный аккаунт Google)
- Клиент: [`src/sheets/client.ts`](src/sheets/client.ts)

### Состояние

Pending-транзакции хранятся **в памяти** (`Map<number, ParsedMessage>`).
Персистентного хранилища нет — только Google Sheets.

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

- **Node.js** ≥ 22.0.0 (использует `--env-file` флаг)
- **Переменные**: `BOT_TOKEN`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ALLOWED_USER_ID`, `LOG_LEVEL`
- **Тестов нет** — покрытие планируется в будущем
- **CI/CD нет** — деплой планируется через Docker (Фаза 5)

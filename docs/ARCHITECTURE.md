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

- `awaiting_added` → `/start` → показывает email сервисного аккаунта + ссылку на Telegraph-инструкцию
- `awaiting_sheet_url` → после нажатия "Добавил" → ждёт ссылку на таблицу + ссылку на Telegraph-инструкцию
- `awaiting_categories_confirm` → после проверки доступа → ждёт подтверждения категорий

URL инструкции: `src/config/telegraph.ts`. Обновление статьи: `node scripts/publish-telegraph.mjs` (исходники в `docs/instructions/`).

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

## Окружение

- **Локальная разработка**: Windows 11 + WSL2 (Ubuntu). Все команды выполняются внутри WSL.
- **Node.js** ≥ 22.0.0 (использует `--env-file` флаг); на проде — Node.js 24 LTS
- **Переменные**: см (.env.example)
- **SQLite**: `data/budget-bot.db`. Создаётся автоматически через `initDb()`.
- **CI/CD**: GitHub Actions — push в `main` → SSH-деплой на Aeza VPS. Подробнее: [`docs/INFRA.md`](docs/INFRA.md)
- **Process manager**: PM2 (`ecosystem.config.cjs`), автозапуск через `pm2 startup`

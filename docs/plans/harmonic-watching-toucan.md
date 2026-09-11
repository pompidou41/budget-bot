# Перезапуск budget-bot под таблицу v2 + AI-ввод

## Context

Таблица «Расходы/доходы» пересобрана (см. `docs/SHEET_V2.md`): вместо плоского `Операции A:E` + листа «Сводка» теперь
счета, валюты, переводы, курсы, разовые траты, всё считается формулами. Старый бот сломан: пишет в `A:E`, обновляет
несуществующую «Сводку», читает категории из неё. Мультиюзерность (регистрация, SQLite) больше не нужна.

Цель: однопользовательский бот, который принимает **любой текст, голосовое или фото чека**, через AI превращает его
в одну или несколько операций формата v2, показывает **черновик**, и после подтверждения пишет строку в `Операции!A:K`.
Хостинг остаётся на Aeza VPS (PM2 + GitHub Actions). Работа ведётся в этом репо, в `main`.

### Решения пользователя
- Оставить: `/undo`, `/balance` (новое), кнопочный мастер (переделанный под v2). Убрать: отчёты, настройки, регистрацию,
  «Сводку», меню-навигацию.
- Всегда черновик перед записью; правка черновика ответом (reply) текстом/голосом.
- Несколько операций в одном сообщении; фото чека/скриншота; алиасы счетов.
- Если счёт не назван — **не угадывать**, спрашивать кнопками.
- AI: OpenRouter `google/gemini-3.7-flash` (есть и `3.8-flash` за ту же цену — модель в env) + Groq
  `whisper-large-v3-turbo` для голоса. Часовой пояс `Europe/Moscow`.

## Ревью текущего кода (что учтено в плане)
1. 🔴 `.mcp.json` содержит закоммиченный Context7 API key (с коммита `init`) → отозвать ключ, заменить на `${CONTEXT7_API_KEY}`.
2. 🔴 `values.append` на лист с ARRAYFORMULA в L:T может вставить строку не туда → писать `values.update` в первую пустую строку по столбцу A.
3. 🔴 `/undo` чистит последнюю строку листа, кто бы её ни внёс → удалять только строку, записанную ботом, и только если её содержимое не менялось.
4. 🟠 Фильтр дат по строкам ломается на локализованных датах; `toISOString()` (UTC) vs локальное время → все даты через `Intl` в `Europe/Moscow`, чтение с `UNFORMATTED_VALUE`.
5. 🟠 Один pending-черновик на юзера → старые кнопки сохраняют чужой черновик. Черновики привязываются к `draftId` в callback data.
6. 🟡 Мёртвый код (`commands/categories.ts`, `commands/summary.ts`, `node-cron`), `bot.catch` молчит для пользователя, тестов нет.

## Целевая архитектура

```
src/
  index.ts                 старт: env → sheets → reference → schema-check → bot.start()
  config/env.ts            zod-схема env (см. ниже)
  config/aliases.ts        ID счёта → ['альфа','alfa','тинёк кредитка',...] (редактируется руками)
  logger.ts                pino; pino-pretty только вне production
  domain/
    operation.ts           тип Operation, toRow() → A:K, validate(op, ref) → список проблем
    dates.ts               today/yesterday/parse в BOT_TIMEZONE
    card.ts                Operation (+проблемы) → HTML-карточка черновика
  sheets/
    client.ts              (оставить как есть)
    reference.ts           Счета A:F(+J:K), Categories C:R → кэш с TTL 10 мин, reload()
    operations.ts          findFreeRow(), writeRow(), readRow(), clearRow(); mutex на запись
    schema-check.ts        сверка шапки Операции!A1:K1 со ожидаемой; при расхождении — запрет записи + сообщение владельцу
  ai/
    openrouter.ts          fetch /chat/completions, response_format json_schema strict, provider.require_parameters
    parse.ts               buildSchema(ref), buildPrompt(ref, today), parse(text|image, currentDraft?) → Operation[]
    transcribe.ts          Groq /audio/transcriptions (language=ru)
  state/journal.ts         data/journal.json: последние ~50 записей бота {row, values, savedAt}
  bot/
    index.ts               сборка бота, bot.catch → ответ владельцу
    guard.ts               пропускать только OWNER_TELEGRAM_ID, остальных молча игнорировать
    drafts.ts              Map<draftId, Draft> в памяти, TTL 24ч
    keyboards.ts
    handlers/input.ts      text / voice / photo → AI → карточки черновиков; reply на карточку → правка
    handlers/draft.ts      callbacks d:<id>:save|cancel|acc|to|cat|sub|date|oneoff
    handlers/wizard.ts     кнопочный мастер → собирает Operation → та же карточка черновика
    commands.ts            /start /help /add /undo /balance /refresh
```

**Удалить:** `src/db/**`, `bot/middleware/auth.ts`, `handlers/registration.ts`, `handlers/summary.ts`,
`handlers/message-parser.ts`, `handlers/transaction.ts`, старый `handlers/wizard.ts`, `commands/*`,
`sheets/brief-*.ts`, `sheets/access-check.ts`, `sheets/transactions.ts`, `config/categories.ts`, `config/telegraph.ts`.
Зависимости: убрать `better-sqlite3`, `@types/better-sqlite3`, `node-cron`, `@types/node-cron`; добавить `vitest` (dev).
HTTP к OpenRouter/Groq — нативный `fetch` + `FormData`, без SDK.

### Env (`src/config/env.ts`)
`BOT_TOKEN`, `OWNER_TELEGRAM_ID` (обязателен, заменяет `ADMIN_USER_ID`), `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
`GOOGLE_PRIVATE_KEY`, `SPREADSHEET_ID` (default — id из SHEET_V2.md), `OPENROUTER_API_KEY`,
`OPENROUTER_MODEL=google/gemini-3.7-flash`, `GROQ_API_KEY`, `GROQ_STT_MODEL=whisper-large-v3-turbo`,
`BOT_TIMEZONE=Europe/Moscow`, `LOG_LEVEL`.

### Модель данных
```ts
type OpType = 'Расход' | 'Доход' | 'Перевод';
interface Operation {
  date: string;          // A, YYYY-MM-DD (USER_ENTERED → дата)
  type: OpType;          // B
  account: string | null;// C, ID из Счета.A (null = спросить)
  amount: number | null; // D, > 0, в валюте счёта C
  toAccount: string | null; // E, только Перевод
  received: number | null;  // F, обязателен при разных валютах C/E
  category: string | null;  // G
  subcategory: string | null; // H
  comment: string;       // I
  oneOff: boolean;       // J, чекбокс → true/false
  manualRate: number | null; // K
  mentionedCurrency: string | null; // не пишется; для предупреждения «сумма в USD, а счёт в RUB»
}
```
`validate()` возвращает проблемы: нет счёта/суммы/категории; счёт `Архив` запрещён; подкатегория не из колонки
категории; у Расход/Доход есть `toAccount`; у Перевода нет `toAccount` или он = `account`; разные валюты без `received`;
`mentionedCurrency` ≠ валюта счёта. Пока проблемы есть — «Сохранить» отвечает alert’ом со списком.
Для Перевода по умолчанию `category = Transfer`.

### Запись в лист (`sheets/operations.ts`)
- Все записи через промис-мьютекс (последовательно).
- `findFreeRow()`: `values.get Операции!A:A` → первая пустая ячейка после шапки (заполняет «дырки» после undo), иначе `len+1`.
- `writeRow(n, toRow(op))`: `values.update Операции!A{n}:K{n}`, `USER_ENTERED`. Затем `readRow(n)` по `A{n}:N{n}`
  с `UNFORMATTED_VALUE` → в ответ «Записано, строка 512 · ≈ $3.45» (столбец N).
- Журнал: `state/journal.ts` пишет `{row, values, savedAt}` в `data/journal.json` (переживает рестарт).
- `/undo` и кнопка «↩️ Отменить» под «Записано»: берём запись журнала → читаем `A:K` строки → если совпадает с
  сохранённым — `values.clear A{n}:K{n}`, иначе отказ «строка изменена вручную». L:T не трогаем никогда.

### Справочники (`sheets/reference.ts`)
- Счета: строки `A:F` (+`J:K` для `/balance`), ID с `Тип = Архив` исключаются из выбора.
- Категории: `Categories!C1:R` — заголовки = категории, непустые ячейки ниже = подкатегории.
- Кэш 10 мин + `/refresh`. Никакого хардкода счетов/категорий.

### AI-разбор (`ai/parse.ts`)
- Системный промпт: сегодня (дата + день недели в МСК), таблица счетов `ID | Название | Банк | Тип | Валюта | алиасы`,
  правила из SHEET_V2 §6 (Перевод = движение между своими счетами, включая обмен и USDT; `received` при разных валютах;
  `oneOff` только для крупных нетипичных трат; **счёт не угадывать — null, если не назван явно или алиасом**;
  комментарий коротко по-русски).
- Ответ строго по JSON-схеме, построенной из справочников: `{ operations: Operation[], note: string|null }`;
  `account/toAccount` — enum ID + null; категория+подкатегория — enum строк `"Food / Groceries"` (гарантирует валидную пару).
  После ответа — повторная проверка zod + `validate()`. Если провайдер отвергнет strict-схему (nullable/enum в Gemini) —
  fallback на `json_object` + zod.
- Запрос: `provider: { require_parameters: true, data_collection: 'deny' }`, `temperature: 0`.
- Правка ответом: reply на карточку → в модель уходит текущая операция JSON + текст правки → одна обновлённая операция → `editMessageText`.
- Фото: самый большой `photo` → base64 data URL в `image_url`, caption как доп. текст.
- Голос: `getFile` → скачать ogg → Groq (`language=ru`) → в карточке строка «🎙 …расшифровка…». Лимит 120 с.
- Несколько операций → отдельная карточка на каждую (каждая со своими кнопками).

### Карточка черновика
`📉 Расход · 11.09 · T_MAIN (RUB)` / сумма / категория › подкатегория / комментарий / разовая / ⚠️ проблемы.
Кнопки: `✅ Сохранить` `❌ Отмена` / `🏦 Счёт` `📂 Категория` `📅 Дата` `⚡ Разовая`; для Перевода `➡️ Куда`.
Выбор счёта/категории/подкатегории — inline-клавиатуры с индексами в callback data (лимит 64 байта).
Сумма/комментарий/курс — правкой ответом.

### Кнопочный мастер (`/add`)
Дата → Тип → Счёт → [Перевод: Куда] → Сумма (текст) → [разные валюты: Получено] → [не Перевод: Категория → Подкатегория]
→ Комментарий/Пропустить → та же карточка черновика. Состояние — в `drafts.ts` (шаг внутри Draft).

### `/balance`
Счета `A:K` (UNFORMATTED): по группам `F`, `J` в валюте счёта + `K` в USD; итог USD по счетам с `G = TRUE`.

## Порядок работ (коммиты в `main`)

> ⚠️ Push в `main` = автодеплой. Коммитить локально, пушить только когда шаги 1–6 готовы и проверены на копии таблицы
> (или временно отключить workflow).

0. **Безопасность**: отозвать Context7 key, в `.mcp.json` → `${CONTEXT7_API_KEY}`.
1. **Чистка**: удалить модули/зависимости из списка выше; новый `env.ts`; `guard.ts`; каркас `bot/index.ts` с `/start`, `/help`, `bot.catch`.
2. **Sheets v2**: `reference.ts`, `schema-check.ts`, `operations.ts`, `journal.ts`, `domain/operation.ts|dates.ts`. Скрипт
   `scripts/check-sheet.ts` (read-only): печатает счета/категории, сверяет шапку.
3. **Черновики без AI**: `drafts.ts`, `card.ts`, `handlers/draft.ts`, `/undo`, мастер `/add` — бот уже полезен.
4. **AI-текст**: `ai/openrouter.ts`, `ai/parse.ts`, `handlers/input.ts` (текст, несколько операций, reply-правка), `aliases.ts`.
5. **Голос + фото**: `ai/transcribe.ts`, ветки voice/photo в `input.ts`.
6. **`/balance`, `/refresh`**, `setMyCommands` в scope чата владельца.
7. **Деплой и доки**: `deploy.yml` (новые secrets `OWNER_TELEGRAM_ID`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`; vars
   `SPREADSHEET_ID`, `BOT_TIMEZONE`, `OPENROUTER_MODEL`), убрать `ADMIN_USER_ID`; `deploy.sh` без изменений по сути
   (сборка без native-модуля). Выдать сервисному аккаунту доступ редактора к таблице v2. Обновить `CLAUDE.md`
   (архитектура, паттерны, состояние, статус), `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `docs/PRD.md`, `docs/BACKLOG.md`
   (закрыть FEAT-002/006/013, удалить FEAT-014/003), закоммитить `docs/SHEET_V2.md`.

## Проверка
- `yarn typecheck && yarn lint && yarn test` — unit-тесты vitest (без сети): `toRow`, `validate`, даты в МСК около полуночи,
  `findFreeRow` на массивах с дырками, сборка JSON-схемы, разбор фикстур ответов модели через zod, сверка журнала при undo.
- Разработка на **копии таблицы** (Файл → Создать копию, свой `SPREADSHEET_ID` в локальном `.env`) и отдельном dev-токене бота.
- `yarn tsx --env-file=.env scripts/check-sheet.ts` — справочники читаются, шапка совпадает.
- Сценарии в Telegram (`yarn dev`):
  - «кофе 300» → черновик спрашивает счёт → выбрать T_MAIN → Сохранить → строка в A:K, L:T посчитались, в ответе ≈ $.
  - «такси 500 с альфы и продукты 2300 налом» → две карточки с ALFA_MAIN и CASH_RUB.
  - «перевёл 100 usdt с байбита на хелекет» → Перевод BYBIT_USDT→HEL_MAIN; «обменял 10000 руб на 110 usdt» → требует/заполняет `received`.
  - reply «это было вчера» → дата меняется в той же карточке.
  - голосовое и фото чека → карточки с расшифровкой/распознанной суммой.
  - `/undo` → строка очищена; повторно после ручной правки строки → отказ.
  - `/add` мастер до записи; `/balance`; сообщение с чужого аккаунта → игнор.
- После пуша: GitHub Actions зелёный, `pm2 logs budget-bot` — «Starting bot», schema-check OK.

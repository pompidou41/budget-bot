# Архитектура

Однопользовательский бот: любое сообщение владельца (текст, голосовое, фото) → AI → черновик операции →
после подтверждения одна строка в лист «Операции» таблицы v2 (структура — [`SHEET_V2.md`](SHEET_V2.md)).
Бот пишет **только** `Операции!A:K`; столбцы L:T и все остальные листы считаются формулами.

```
Telegram ─► guard (только OWNER_TELEGRAM_ID, private chat)
   │
   ├─ /add /undo /balance /refresh /help ──────────────► handlers/commands.ts
   ├─ кнопки d:<draftId>:<action>[:<arg>] ─────────────► handlers/draft.ts
   ├─ кнопки u:<row> (отмена записи) ──────────────────► handlers/commands.ts
   └─ текст / голос / фото / картинка-документ ────────► handlers/input.ts
          голос ─► Groq Whisper ─► текст
          reply на карточку ─► parser.edit()  ─┐
          ответ на вопрос мастера ─► applyInput│
          иначе ─► parser.parse() ─► Operation[] ─► карточки черновиков
                                                   │
                        ✅ Сохранить ─► validate ─► repo.append (A:K) ─► journal ─► «↩️ Отменить»
```

## Модули

| Путь                           | Роль                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `src/index.ts`                 | Сборка зависимостей (`AppDeps`), загрузка справочников, проверка шапки, команды, старт  |
| `src/config/env.ts`            | zod-схема env; пустые строки → значения по умолчанию                                    |
| `src/config/aliases.ts`        | Алиасы счетов для AI («альфа» → `ALFA_MAIN`), правится руками                           |
| `src/domain/*`                 | Чистая логика без I/O: `Operation`, `validate`, `toRow`, даты в TZ, карточка, остатки   |
| `src/sheets/reference.ts`      | Чтение «Счета» `A2:K` и «Categories» `C1:…` с кэшем 10 мин                              |
| `src/sheets/operations.ts`     | Запись/очистка строки «Операции» под мьютексом                                          |
| `src/sheets/schema-check.ts`   | Сверка шапки `Операции!A1:K1`; при расхождении запись блокируется                       |
| `src/state/journal.ts`         | `data/journal.json` — последние 50 записей бота для `/undo`                             |
| `src/ai/openrouter.ts`         | HTTP к OpenRouter, strict JSON schema, fallback на `json_object`                        |
| `src/ai/parse.ts`              | Промпт, схема ответа, маппинг ответа модели ↔ `Operation`                               |
| `src/ai/transcribe.ts`         | Groq Whisper (`language=ru`)                                                            |
| `src/bot/drafts.ts`            | In-memory хранилище черновиков                                                          |
| `src/bot/draft-actions.ts`     | Чистые переходы черновика: нажатие кнопки, ввод текста                                  |
| `src/bot/wizard.ts`            | Порядок шагов мастера `/add` и пропуск неприменимых                                     |
| `src/bot/render.ts`, `keyboards.ts` | Текст и клавиатура сообщения черновика для текущего вида                           |
| `src/bot/handlers/*`           | grammY-обработчики (тонкий слой над domain/sheets/ai)                                   |

## Ключевые паттерны

### Operation

```typescript
interface Operation {
  date: string; // A, YYYY-MM-DD в BOT_TIMEZONE
  type: 'Расход' | 'Доход' | 'Перевод'; // B
  account: string | null; // C, ID из «Счета»; null = ещё не выбран
  amount: number | null; // D, в валюте счёта C
  toAccount: string | null; // E, только перевод
  received: number | null; // F, только перевод; обязателен при разных валютах C/E
  category: string | null; // G
  subcategory: string | null; // H, обязательна, если у категории есть подкатегории
  comment: string; // I
  oneOff: boolean; // J, чекбокс «Разовая»
  manualRate: number | null; // K
  mentionedCurrency: string | null; // не пишется; валюта, в которой пользователь назвал сумму
}
```

- `normalizeOperation` держит поля согласованными: у не-переводов нет E/F, у перевода по умолчанию категория `Transfer`,
  подкатегория сбрасывается, если не принадлежит категории.
- `validate` возвращает список проблем на русском; пока он не пуст, «Сохранить» показывает alert.
- `toRow` → значения A:K. Текст, начинающийся с `= + - @`, получает префикс `'`, чтобы `USER_ENTERED` не сделал формулу.

### Справочники (`Reference`)

Счета и категории всегда читаются из таблицы, никакого хардкода. Счета с типом/группой `Архив` в выбор не попадают.
Категории — заголовки столбцов `Categories!C1…` до столбца `CategoryList`, подкатегории — непустые ячейки под ними.
`/refresh` перечитывает принудительно; при ошибке чтения используется устаревший кэш.

### Черновик (`Draft`)

```typescript
type DraftView =
  | { kind: 'card' } // карточка с кнопками Сохранить / Счёт / Категория / Дата / Тип / Разовая
  | { kind: 'pick'; picker: 'acc' | 'to' | 'cat' | 'sub' | 'date' | 'type' }
  | { kind: 'input'; field: 'amount' | 'received' | 'comment' | 'date'; since: number };
```

- Черновик привязан к сообщению-карточке (`messageId`); callback data — `d:<draftId>:<action>[:<arg>]`,
  списки адресуются **индексом** (лимит Telegram 64 байта, названия бывают кириллическими).
- `wizard: true` — режим `/add`: после каждого ответа `nextWizardView` выбирает следующий применимый шаг
  (дата → тип → счёт → [куда] → сумма → [получено] → [категория] → подкатегория → комментарий).
- Правка ответом (reply) на карточку отправляет текущую операцию + текст правки в `parser.edit`.
- Текстовый ввод для `input`-вида ждёт 15 минут; голосовое всегда создаёт новую операцию.

### AI-разбор

- Модель получает таблицу счетов (ID, название, банк, тип, валюта, алиасы), список категорий, сегодняшнюю дату и правила
  из SHEET_V2 §6. **Счёт не угадывается**: не назван явно → `NONE` → бот спрашивает кнопками.
- Схема ответа строится из справочников: `account`/`toAccount` — enum ID + `NONE`, категория — enum пар
  `"Категория / Подкатегория"` (гарантирует валидную пару). Вместо `null` — сентинелы (`NONE`, `0`, `""`),
  т.к. strict-режимы провайдеров по-разному поддерживают nullable.
- Ответ дополнительно парсится мягкой zod-схемой (`.catch` на каждом поле) и проходит `normalizeOperation`.
- OpenRouter: `temperature: 0`, `provider.require_parameters: true`, `provider.data_collection: 'deny'`.

### Запись и отмена

- `repo.append`: под мьютексом читает `Операции!A:A` → первая пустая строка после шапки (заполняет «дырки» после
  отмены) → `values.update A{n}:K{n}` (`USER_ENTERED`) → читает `N{n}` для «≈ $» в ответе.
- Журнал хранит `{row, values, op, savedAt, messageId}`. `/undo` и «↩️ Отменить» очищают `A:K` строки **только если**
  её содержимое совпадает с записанным (`rowMatches` учитывает serial-даты и апостроф). Иначе — отказ.
- После отмены операция возвращается в то же сообщение как черновик — можно поправить и сохранить заново.

### Проверка шапки

При старте и на `/refresh` шапка `Операции!A1:K1` сверяется с ожидаемой (без учёта регистра, `ё/е`, пробелов).
Расхождение → `health.headerProblems`, запись блокируется, владелец получает сообщение.

## Состояние

| Что                     | Где                          | Живёт                                  |
| ----------------------- | ---------------------------- | -------------------------------------- |
| Черновики               | память (`DraftStore`)        | 24 ч, теряются при рестарте            |
| Журнал записей бота     | `data/journal.json`          | последние 50, переживает рестарт       |
| Справочники             | память (`ReferenceStore`)    | кэш 10 мин                             |
| Блокировка записи       | `deps.health.headerProblems` | до успешного `/refresh`                |

---

## Конвенции кода

- **ES-модули** (`"type": "module"`), NodeNext resolution, импорты с расширением `.js`
- **Строгий TypeScript**: strict, noUncheckedIndexedAccess, noImplicitReturns
- **Форматирование**: Prettier (single quotes, semi, trailing commas, printWidth 100), проверяется ESLint
- **Логирование**: только `logger` из [`src/logger.ts`](../src/logger.ts); pretty-вывод вне production
- **Переменные окружения**: только через `loadEnv()` → `AppDeps.env`, не `process.env`
- **Зависимости** передаются явно через `AppDeps`, модульных синглтонов нет
- **Тесты**: vitest в `test/`, без сети; всё, что можно, — чистые функции в `src/domain` и `src/bot/draft-actions.ts`
- **Пакетный менеджер**: yarn classic (lockfile v1). Yarn 4 из corepack его не читает — `npx yarn@1.22.22 …`

---

## Окружение

- **Node.js** ≥ 22 (`--env-file`); на проде — Node.js 24 LTS
- **Переменные**: см. [`.env.example`](../.env.example) и [`INFRA.md`](INFRA.md)
- **Разработка**: на копии таблицы (свой `SPREADSHEET_ID`) и отдельном dev-токене бота; `yarn check-sheet` —
  read-only проверка справочников и шапки
- **CI/CD**: GitHub Actions — typecheck/lint/test, затем SSH-деплой на Aeza VPS, PM2

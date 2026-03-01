# Plan: UX-003, UX-004, FEAT-001, FIX-003

## Context

Четыре задачи из бэклога, выполняются по порядку:
- **UX-003** — убрать промежуточный inline-шаг при нажатии «📋 Меню», перейти на нативное меню Telegram
- **UX-004** — добавить кнопку «Не могу добавить» при регистрации с переадресацией к админу
- **FEAT-001** — пошаговый wizard добавления транзакции через inline-меню
- **FIX-003** — блокировать доступ незарегистрированных пользователей ко всем командам кроме `/start` и регистрационных

---

## UX-003: Нативное меню Telegram вместо reply keyboard

**Проблема**: «📋 Меню» (reply keyboard) → bot отвечает inline `mainMenuKeyboard()` → два слоя меню.
**Решение**: использовать нативное меню Telegram (команды бота через `setMyCommands`). Пользователь нажимает кнопку «⌘» или «Меню» в поле ввода — Telegram показывает зарегистрированные команды большими кнопками (без отправки сообщений).

### Изменения

1. **`src/index.ts`** — после `createBot()` вызвать `bot.api.setMyCommands()` с командами:
   - `summary` → «Саммари за период»
   - `categories` → «Список категорий»
   - `undo` → «Удалить последнюю запись»
   - `help` → «Справка»
   - `menu` → «Главное меню» (оставить как fallback)

2. **`src/bot/keyboards/index.ts`** — удалить `mainReplyKeyboard()` и `MENU_BUTTON_LABEL`

3. **`src/bot/handlers/registration.ts`** — убрать `reply_markup: mainReplyKeyboard()` из `handleRegCatsOk`, `handleRegCatsDefault`, ветки «нет Сводки»

4. **`src/bot/commands/start.ts`** — убрать `reply_markup: mainReplyKeyboard()` из зарегистрированного пользователя

5. **`src/bot/index.ts`** — удалить `bot.hears(MENU_BUTTON_LABEL, ...)` handler, убрать импорт `MENU_BUTTON_LABEL` и `mainReplyKeyboard`

---

## UX-004: Кнопка «Не могу добавить» при регистрации

**Проблема**: нет пути для пользователя, которому не удаётся добавить сервисный аккаунт.
**Решение**: добавить вторую кнопку в первый шаг регистрации.

### Изменения

1. **`src/bot/keyboards/index.ts`** — в `registrationAddedKeyboard()` добавить вторую кнопку:
   ```
   [Добавил ✅]
   [Не могу добавить ❌]   ← callback: reg:cant_add
   ```

2. **`src/bot/handlers/registration.ts`** — новая функция `handleRegCantAdd`:
   ```typescript
   export async function handleRegCantAdd(ctx: BotContext): Promise<void> {
     await ctx.editMessageText(
       'Напишите @pompidou17 — помогу настроить таблицу.',
       { reply_markup: undefined },
     );
     await ctx.answerCallbackQuery();
   }
   ```

3. **`src/bot/index.ts`** — зарегистрировать callback:
   ```typescript
   bot.callbackQuery('reg:cant_add', handleRegCantAdd);
   ```

---

## FIX-003: Auth guard для незарегистрированных пользователей

**Проблема**: `/help` и `hears(MENU_BUTTON_LABEL)` не проверяют `ctx.user`; conceptually — незарегистрированный пользователь должен перенаправляться на `/start`.
**Решение**: глобальный middleware после `userMiddleware`.

### Изменения

1. **`src/bot/handlers/registration.ts`** — экспортировать функцию:
   ```typescript
   export function hasRegistrationState(userId: number): boolean {
     return states.has(userId);
   }
   ```

2. **`src/bot/middleware/auth.ts`** — новая функция `authGuardMiddleware()`:
   - Если `ctx.user` есть → `next()`
   - Если нет `ctx.user`, но `ctx.from.id` в `states` (активная регистрация) → `next()`
   - Если callback начинается с `reg:` → `next()`
   - Если команда `/start` → `next()`
   - Иначе → `ctx.reply('Сначала зарегистрируйся. Нажми /start')` и стоп

3. **`src/bot/index.ts`** — добавить middleware сразу после `userMiddleware`:
   ```typescript
   bot.use(authGuardMiddleware());
   ```

---

## FEAT-001: Wizard добавления транзакции

**Цель**: альтернативный способ ввода через inline-меню (5 шагов).

### Шаги wizard

```
Старт (menu:add_tx)
  └─ Дата: [Сегодня] [Вчера] [Другая дата]
       └─ Если «Другая дата» → ждать текст (YYYY-MM-DD или DD.MM.YYYY)
  └─ Тип: [Расход] [Доход]
  └─ Категория: список кнопок из user.expenseCategories / incomeCategories
  └─ Сумма: ждать текст (число)
  └─ Комментарий: [Пропустить] или текст
  └─ Подтверждение: те же кнопки что и при текстовом вводе (confirmTransactionKeyboard)
     → tx:confirm / tx:cancel
```

### Состояние wizard

Новый тип в `src/bot/handlers/wizard.ts`:
```typescript
type WizardStep = 'date' | 'type' | 'category' | 'amount' | 'comment';
interface WizardState {
  step: WizardStep;
  date?: string;
  type?: 'expense' | 'income';
  category?: string;
  amount?: number;
}
const wizardStates = new Map<number, WizardState>();
export function hasWizardState(userId: number): boolean { ... }
```

### Новые клавиатуры в `src/bot/keyboards/index.ts`

- `wizardDateKeyboard()` — [Сегодня] [Вчера] / [Другая дата]
- `wizardTypeKeyboard()` — [Расход] [Доход]
- `wizardCategoryKeyboard(categories)` — аналог `categorySelectionKeyboard`, callback `wzd:cat:<name>`
- `wizardCommentKeyboard()` — [Пропустить]

### Интеграция в `src/bot/index.ts`

1. Добавить кнопку «Добавить операцию» в `mainMenuKeyboard()` → callback `menu:add_tx`
2. Зарегистрировать callback `menu:add_tx` → запуск wizard
3. Зарегистрировать `wzd:date_today`, `wzd:date_yesterday`, `wzd:date_custom`
4. Зарегистрировать `wzd:type_expense`, `wzd:type_income`
5. Зарегистрировать `/^wzd:cat:/` → выбор категории
6. Зарегистрировать `wzd:skip_comment` → пропуск комментария
7. Добавить text handler перед transaction handler: если `hasWizardState(userId)` → передать в wizard text handler
8. Также обновить `authGuardMiddleware` — пропускать текст когда пользователь в wizard (или уже covered через `ctx.user`)

### Текстовый ввод в wizard

Wizard ожидает текст на шагах `amount` и `comment` (и опционально `date`).
В `src/bot/index.ts` в цепочке `message:text`:
```
handleRegistrationText → handleWizardText → transactionHandler
```

`handleWizardText(ctx, next)` проверяет `wizardStates.get(userId)` и обрабатывает ввод, иначе `next()`.

---

## Критические файлы

| Файл | Задача |
|------|--------|
| `src/index.ts` | UX-003: setMyCommands |
| `src/bot/index.ts` | UX-003, UX-004, FIX-003, FEAT-001 |
| `src/bot/keyboards/index.ts` | UX-003, UX-004, FEAT-001 |
| `src/bot/handlers/registration.ts` | UX-003, UX-004, FIX-003 |
| `src/bot/middleware/auth.ts` | FIX-003 |
| `src/bot/commands/start.ts` | UX-003 |
| `src/bot/handlers/wizard.ts` | FEAT-001 (новый файл) |

---

## Обновление документации

После реализации всех задач обновить следующие файлы:

### `docs/BACKLOG.md`
- Пометить `UX-003`, `UX-004`, `FEAT-001`, `FIX-003` как `[x]` (завершено)
- Добавить краткую заметку о реализации к каждому пункту

### `docs/PLAN.md`
- В раздел «Фаза 4 — Доработки» добавить завершённые пункты:
  - `[x] Нативное меню команд Telegram (UX-003)`
  - `[x] Негативный сценарий регистрации (UX-004)`
  - `[x] Auth guard для незарегистрированных (FIX-003)`
  - `[x] Wizard добавления транзакции (FEAT-001)`
- В раздел «Структура проекта» добавить `src/bot/handlers/wizard.ts`

### `CLAUDE.md`
- В блоке «Архитектура» добавить `wizard.ts` в `bot/handlers/`
- В блоке «Ключевые паттерны» добавить описание wizard-флоу
- Обновить `middleware/auth.ts` — описание расширить: теперь содержит `authGuardMiddleware` (блокирует незарегистрированных)
- Обновить статус: «Текущая фаза: UX-доработки — завершены»

---

## Порядок реализации

1. **UX-003** (удалить reply keyboard + setMyCommands) — не ломает логику
2. **UX-004** (кнопка «Не могу добавить») — изолированное изменение
3. **FIX-003** (auth guard) — после UX-003, т.к. убираем `hears(MENU_BUTTON_LABEL)` и нужно проверить полный список разрешённых путей
4. **FEAT-001** (wizard) — наиболее объёмная, выполняется последней

---

## Верификация

- **UX-003**: Зайти в бот незарегистрированным, нажать «⌘» / «/» — увидеть список команд как в скриншоте. Убедиться что reply keyboard больше не показывается после регистрации.
- **UX-004**: Начать регистрацию, нажать «Не могу добавить» — получить сообщение с @pompidou17.
- **FIX-003**: Отправить незарегистрированным пользователем `/summary`, `/categories`, `/undo`, текстовое сообщение — каждый раз получать редирект на `/start`. Убедиться, что `/start` и шаги регистрации работают.
- **FEAT-001**: Открыть меню → «Добавить операцию» → пройти все 5 шагов → убедиться что транзакция записана в Google Sheets и обновилась Сводка.

# Plan: FIX-002 + UX-006 + FEAT-004

## Context

Три задачи из бэклога, исправляющие существующие проблемы и добавляющие защиту от случайного удаления:

- **FIX-002**: «Все траты», «Все доходы» и «Последние записи» показывают тот же ответ, что и «Саммари» — потому что все три роута используют `summaryPeriodKeyboard` и одинаковые `summary:*` колбэки.
- **UX-006**: После завершения регистрации в чате остаётся лишнее сообщение «Регистрация завершена! Можешь записывать траты.», а отредактированное сообщение с инлайн-кнопкой тоже засоряет чат.
- **FEAT-004**: `/undo` немедленно удаляет последнюю запись без подтверждения — нужен диалог подтверждения с деталями транзакции.

---

## Файлы для изменения

| Файл | Задача |
|---|---|
| `src/bot/handlers/registration.ts` | UX-006 |
| `src/bot/keyboards/index.ts` | FEAT-004 + FIX-002 |
| `src/bot/commands/undo.ts` | FEAT-004 |
| `src/bot/handlers/summary.ts` | FIX-002 |
| `src/bot/index.ts` | FEAT-004 + FIX-002 |

---

## UX-006 — Удаление лишних сообщений после регистрации

**Файл:** `src/bot/handlers/registration.ts`

В `handleRegCatsOk` и `handleRegCatsDefault` заменить паттерн:
```
ctx.editMessageText(...)        // остаётся в чате как шум
ctx.answerCallbackQuery(...)
ctx.reply('Регистрация завершена! ...')   // дублирующее сообщение
ctx.reply(WELCOME_TEXT, ...)
```
На:
```
try { await ctx.deleteMessage(); } catch {} // удалить сообщение с кнопками
ctx.answerCallbackQuery('Регистрация завершена!')
ctx.reply(WELCOME_TEXT, { parse_mode: 'HTML' })
```

`deleteMessage()` обёрнут в try/catch — на случай если сообщение старше 48 ч (ограничение Telegram API). Путь через `handleRegistrationText` (без Сводки) не меняется — там нет инлайн-кнопок.

---

## FEAT-004 — Подтверждение перед /undo

### `src/bot/keyboards/index.ts`
Добавить в конец файла:
```typescript
export function undoConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Удалить ✅', 'undo:confirm')
    .text('Отмена ❌', 'undo:cancel');
}
```

### `src/bot/commands/undo.ts`
Полная переработка файла. Заменить 2 функции на 4:

1. **`createUndoPreviewHandler()`** (заменяет `createUndoCommand`) — читает транзакции через `getTransactions()`, берёт последнюю, показывает детали (дата/тип/категория/сумма/комментарий) + `undoConfirmKeyboard()`. Отвечает `ctx.reply`.

2. **`createUndoCallbackPreviewHandler()`** (заменяет `createUndoCallbackHandler`) — аналог для `op:undo` колбэка, использует `ctx.editMessageText`.

3. **`createUndoConfirmHandler()`** — вызывается при `undo:confirm`: выполняет `deleteLastTransaction()`, показывает «Удалено: ...» + `operationsMenuKeyboard()`. Обёрнут в try/catch с логированием.

4. **`createUndoCancelHandler()`** — вызывается при `undo:cancel`: показывает «Отмена.» + `operationsMenuKeyboard()`.

Новые импорты: `getTransactions` из sheets, `undoConfirmKeyboard` и `operationsMenuKeyboard` из keyboards, `logger`.

### `src/bot/index.ts`
- Обновить импорт из `undo.ts` (4 новые функции)
- `bot.command('undo', createUndoPreviewHandler())`
- Заменить блок `op:undo`:
  ```
  bot.callbackQuery('op:undo', createUndoCallbackPreviewHandler())
  bot.callbackQuery('undo:confirm', createUndoConfirmHandler())
  bot.callbackQuery('undo:cancel', createUndoCancelHandler())
  ```

---

## FIX-002 — Раздельные ответы для траты/доходы/последние записи

### `src/bot/keyboards/index.ts`
Добавить shared-фабрику и три именованных клавиатуры:
```typescript
export function periodKeyboard(prefix: string, backCallback?: string): InlineKeyboard {
  // кнопки: week, month, prev_month, all с данным prefix
  // опционально кнопка ← Назад
}

export function expensesPeriodKeyboard(): InlineKeyboard {
  return periodKeyboard('expenses:', 'nav:reports');
}
export function incomePeriodKeyboard(): InlineKeyboard {
  return periodKeyboard('income:', 'nav:reports');
}
export function recentPeriodKeyboard(): InlineKeyboard {
  return periodKeyboard('recent:', 'nav:reports');
}
```

`summaryPeriodKeyboard` рефакторим через `periodKeyboard('summary:', backCallback)`.

### `src/bot/handlers/summary.ts`
Добавить 3 builder-функции и 3 handler-factory (все приватные builder, экспортируются только factory):

- **`buildExpensesText(transactions, label)`** — только расходы, отсортированные по убыванию суммы, с итогом
- **`buildIncomeText(transactions, label)`** — только доходы, аналогично
- **`buildRecentText(transactions, label)`** — последние 20 транзакций в обратном хронологическом порядке (emoji 📉/📈, дата, категория, сумма, комментарий)

Три factory: `createExpensesCallbackHandler()`, `createIncomeCallbackHandler()`, `createRecentCallbackHandler()` — каждая разбирает свой префикс и использует соответствующий builder.

### `src/bot/index.ts`
- Добавить импорты трёх новых handler-factory из `summary.ts`
- Добавить импорты трёх новых клавиатур из `keyboards/index.ts`
- Добавить регистрацию колбэков после существующего `summary:`:
  ```
  bot.callbackQuery(/^expenses:/, createExpensesCallbackHandler())
  bot.callbackQuery(/^income:/, createIncomeCallbackHandler())
  bot.callbackQuery(/^recent:/, createRecentCallbackHandler())
  ```
- Исправить `nav:expenses`, `nav:income`, `nav:recent` — заменить `summaryPeriodKeyboard('nav:reports')` на соответствующие клавиатуры

---

## Порядок реализации

1. UX-006 (`registration.ts`) — самое маленькое изменение
2. FEAT-004 (`keyboards/index.ts` → `undo.ts` → `bot/index.ts`)
3. FIX-002 (`keyboards/index.ts` → `summary.ts` → `bot/index.ts`)

---

## Проверка

```bash
yarn typecheck      # убедиться что нет ошибок типов
yarn lint           # проверить стиль
yarn dev            # запустить бот и проверить сценарии:
```

**Сценарии для ручного тестирования:**
1. Пройти регистрацию до конца — убедиться что в чате только одно финальное сообщение (WELCOME_TEXT)
2. Добавить транзакцию, затем нажать «Отменить последнюю» → должен появиться диалог с деталями
3. Нажать «Удалить ✅» → транзакция удалена, показано меню операций
4. Нажать «Отмена ❌» → отмена, показано меню операций
5. Зайти в Отчёты → «Все траты» → выбрать период → убедиться что показаны только расходы
6. Аналогично «Все доходы» → только доходы
7. «Последние записи» → хронологический список транзакций
8. «Саммари» → полное саммари (не изменилось)

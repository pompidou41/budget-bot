# План: Реструктуризация навигации бота

## Контекст

Сейчас у бота плоская структура команд без иерархии. Нужно добавить 4 родительские команды (/menu, /reports, /settings, /operations), каждая из которых открывает своё инлайн-меню с дочерними действиями. Это улучшит UX и сделает навигацию более интуитивной.

---

## Целевая структура

```
/menu        → главное меню → 4 инлайн-кнопки (/reports, /settings, /operations, /help)
/reports     → инлайн-кнопки: Саммари за период | Все траты | Все доходы | Последние записи
/settings    → инлайн-кнопки: Список категорий | Ссылка на Google-таблицу
/operations  → инлайн-кнопки: Добавить операцию | Отменить последнюю операцию
/help        → справка (текстовый ответ, без изменений)
```

---

## Что нужно сделать

### 1. `src/bot/keyboards/index.ts` — новые клавиатуры

Добавить 4 новые функции клавиатур:

```typescript
// Главное меню — 4 кнопки-ссылки на разделы
export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Отчёты', 'nav:reports')
    .text('⚙️ Настройки', 'nav:settings')
    .row()
    .text('💸 Операции', 'nav:operations')
    .text('❓ Справка', 'nav:help');
}

// /reports
export function reportsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Саммари за период', 'nav:summary')
    .row()
    .text('Все траты', 'nav:expenses')
    .text('Все доходы', 'nav:income')
    .row()
    .text('Последние записи', 'nav:recent')
    .row()
    .text('← Назад', 'nav:main_menu');
}

// /settings
export function settingsMenuKeyboard(sheetUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Список категорий', 'nav:categories')
    .row()
    .url('🔗 Google-таблица', sheetUrl)
    .row()
    .text('← Назад', 'nav:main_menu');
}

// /operations
export function operationsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Добавить операцию', 'menu:add_tx')
    .row()
    .text('↩️ Отменить последнюю', 'op:undo')
    .row()
    .text('← Назад', 'nav:main_menu');
}
```

Старая `mainMenuKeyboard()` заменяется новой. `summaryPeriodKeyboard` остаётся без изменений (используется из /reports).

### 2. `src/bot/commands/start.ts` — обновить команды

**`menuCommand`** — изменить текст и клавиатуру:
```typescript
export async function menuCommand(ctx: BotContext): Promise<void> {
  await ctx.reply('Главное меню:', { reply_markup: mainMenuKeyboard() });
}
```

Добавить новые команды:
```typescript
export async function reportsCommand(ctx: BotContext): Promise<void> {
  await ctx.reply('Отчёты:', { reply_markup: reportsMenuKeyboard() });
}

export async function settingsCommand(ctx: BotContext): Promise<void> {
  await ctx.reply('Настройки:', { reply_markup: settingsMenuKeyboard(ctx.user!.sheetUrl) });
}

export async function operationsCommand(ctx: BotContext): Promise<void> {
  await ctx.reply('Операции:', { reply_markup: operationsMenuKeyboard() });
}
```

`helpCommand` — обновить список команд в тексте (добавить /reports, /settings, /operations, убрать /summary, /categories, /undo из основного списка).

**`createStartCommand`** — обновить текст справки в приветствии.

### 3. `src/bot/index.ts` — зарегистрировать команды и callback-и

**Новые команды:**
```typescript
bot.command('reports', reportsCommand);
bot.command('settings', settingsCommand);
bot.command('operations', operationsCommand);
```

**Новые callback-и навигации:**
```typescript
// Главное меню
bot.callbackQuery('nav:main_menu', async (ctx) => {
  await ctx.editMessageText('Главное меню:', { reply_markup: mainMenuKeyboard() });
  await ctx.answerCallbackQuery();
});

// Отчёты
bot.callbackQuery('nav:reports', async (ctx) => {
  await ctx.editMessageText('Отчёты:', { reply_markup: reportsMenuKeyboard() });
  await ctx.answerCallbackQuery();
});

// Настройки
bot.callbackQuery('nav:settings', async (ctx) => {
  if (!ctx.user) return;
  await ctx.editMessageText('Настройки:', { reply_markup: settingsMenuKeyboard(ctx.user.sheetUrl) });
  await ctx.answerCallbackQuery();
});

// Операции
bot.callbackQuery('nav:operations', async (ctx) => {
  await ctx.editMessageText('Операции:', { reply_markup: operationsMenuKeyboard() });
  await ctx.answerCallbackQuery();
});

// Справка из меню
bot.callbackQuery('nav:help', async (ctx) => {
  await ctx.editMessageText('<help text>', { parse_mode: 'HTML', reply_markup: backToMainKeyboard() });
  await ctx.answerCallbackQuery();
});

// Категории из настроек
bot.callbackQuery('nav:categories', async (ctx) => {
  // inline вывод списка категорий
  await ctx.answerCallbackQuery();
});

// Undo из операций
bot.callbackQuery('op:undo', async createUndoCallbackHandler());

// Саммари из отчётов — уже есть menu:summary, переименовать в nav:summary
bot.callbackQuery('nav:summary', async (ctx) => {
  await ctx.editMessageText('Выберите период:', {
    reply_markup: summaryPeriodKeyboard('nav:reports'),
  });
  await ctx.answerCallbackQuery();
});

// Траты/Доходы из отчётов
bot.callbackQuery('nav:expenses', ...);
bot.callbackQuery('nav:income', ...);
bot.callbackQuery('nav:recent', ...);  // TODO: реализовать "последние записи"
```

**Удалить/заменить** старые callback-и:
- `back:main_menu` → заменить на `nav:main_menu`
- `menu:summary`, `menu:expenses`, `menu:income` → заменить на `nav:summary`, `nav:expenses`, `nav:income`
- `menu:add_tx` — оставить (уже используется в wizard и теперь в operationsMenuKeyboard)

### 4. `src/bot/commands/undo.ts` — вынести логику в callback

Создать `createUndoCallbackHandler()` — аналог `createUndoCommand()`, но для callback query:
```typescript
export function createUndoCallbackHandler() {
  return async (ctx: BotContext): Promise<void> => {
    // та же логика что в createUndoCommand, но через editMessageText + answerCallbackQuery
  };
}
```

---

## Критические файлы

| Файл | Изменения |
|------|-----------|
| `src/bot/keyboards/index.ts` | Добавить 4 клавиатуры, изменить `mainMenuKeyboard` |
| `src/bot/commands/start.ts` | Обновить `menuCommand`, `helpCommand`, `createStartCommand`; добавить `reportsCommand`, `settingsCommand`, `operationsCommand` |
| `src/bot/index.ts` | Зарегистрировать новые команды и ~10 новых callback-ов |
| `src/bot/commands/undo.ts` | Добавить `createUndoCallbackHandler` |

---

## Что НЕ меняется

- Wizard (wizard.ts) — без изменений, только точка входа `menu:add_tx` остаётся
- Transaction handlers — без изменений
- Registration flow — без изменений
- Summary logic (handlers/summary.ts) — без изменений, `createSummaryCallbackHandler` переиспользуется
- Auth middleware — без изменений

---

## Верификация

1. `yarn typecheck` — проверка типов
2. `yarn dev` — запустить бота
3. Проверить:
   - `/menu` → 4 кнопки разделов
   - `/reports` → 4 кнопки + кнопка назад → саммари работает
   - `/settings` → список категорий, ссылка на таблицу
   - `/operations` → добавить операцию (запускает wizard), отменить последнюю (undo)
   - `/help` → справка
   - Кнопка "← Назад" в каждом подменю возвращает в главное меню

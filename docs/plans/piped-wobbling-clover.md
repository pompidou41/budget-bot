# План: Скрытие команд меню для незарегистрированных пользователей

## Контекст

Сейчас `setMyCommands` устанавливает **глобальный** список команд (5 команд) для всех пользователей, включая незарегистрированных. Незарегистрированный пользователь видит в меню команды `/operations`, `/reports` и т.д., но при их вызове получает блокировку от `authGuardMiddleware`. Это создаёт путаницу.

Telegram Bot API поддерживает **per-chat scope** через `BotCommandScopeChat`, что позволяет задавать разные команды для конкретного чата/пользователя, переопределяя глобальный список.

## Решение

- **Глобальный список** (для всех) → только `/start`
- **Per-chat список** (для конкретного пользователя) → полный список 5 команд, устанавливается сразу после завершения регистрации

## Файлы для изменения

### 1. `src/index.ts`

Заменить глобальный `setMyCommands` на список только с `/start`:

```typescript
await bot.api.setMyCommands([
  { command: 'start', description: 'Начать / Регистрация' },
]),
```

### 2. `src/bot/handlers/registration.ts`

Добавить константу и хелпер в начало файла:

```typescript
const FULL_USER_COMMANDS = [
  { command: 'operations', description: 'Операции' },
  { command: 'reports', description: 'Отчёты' },
  { command: 'settings', description: 'Настройки' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'help', description: 'Справка' },
];

async function setupUserCommands(ctx: BotContext): Promise<void> {
  if (!ctx.chat) return;
  await ctx.api.setMyCommands(FULL_USER_COMMANDS, {
    scope: { type: 'chat', chat_id: ctx.chat.id },
  });
}
```

Вызвать `await setupUserCommands(ctx)` в трёх точках завершения регистрации:

| Функция | Строка | Момент вызова |
|---|---|---|
| `handleRegistrationText()` | ~257 | После сохранения с дефолтными категориями (нет листа "Сводка") |
| `handleRegCatsOk()` | ~117 | После сохранения с разобранными категориями |
| `handleRegCatsDefault()` | ~157 | После сохранения с дефолтными категориями |

В каждой из трёх точек добавить вызов **перед** `ctx.reply(WELCOME_TEXT, ...)`.

## Проверка

1. Новый пользователь → в меню видит только `/start`
2. Пройти регистрацию до конца (любой из 3 сценариев)
3. После приветственного сообщения → в меню появляются все 5 команд
4. Уже зарегистрированный пользователь (у которого уже установлены per-chat команды) → по-прежнему видит 5 команд

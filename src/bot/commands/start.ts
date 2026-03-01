import { startRegistration } from '../handlers/registration.js';
import type { BotContext } from '../context.js';
import type { Env } from '../../config/index.js';
import { mainMenuKeyboard } from '../keyboards/index.js';

export function createStartCommand(env: Env) {
  return async (ctx: BotContext): Promise<void> => {
    if (ctx.user) {
      await ctx.reply(
        `Привет! Я бот для учёта бюджета.\n\n` +
          `Чтобы записать трату, просто напиши сообщение в формате:\n` +
          `<b>Категория Сумма Комментарий</b>\n\n` +
          `Примеры:\n` +
          `• <code>Продукты 1500 Пятёрочка</code>\n` +
          `• <code>Такси 350</code>\n` +
          `• <code>Зарплата 80000</code>\n\n` +
          `Команды:\n` +
          `/menu — главное меню\n` +
          `/summary — саммари за период\n` +
          `/categories — список категорий\n` +
          `/help — справка`,
        { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
      );
    } else {
      await startRegistration(ctx, env);
    }
  };
}

export async function helpCommand(ctx: BotContext): Promise<void> {
  await ctx.reply(
    `<b>Как пользоваться ботом</b>\n\n` +
      `<b>Запись трат/доходов:</b>\n` +
      `Просто напиши сообщение в формате:\n` +
      `<code>Категория Сумма Комментарий</code>\n\n` +
      `Комментарий — необязателен.\n\n` +
      `<b>Команды:</b>\n` +
      `/menu — главное меню с кнопками\n` +
      `/summary — саммари трат за период\n` +
      `/categories — список доступных категорий\n` +
      `/undo — удалить последнюю запись\n` +
      `/help — эта справка`,
    { parse_mode: 'HTML' },
  );
}

export async function menuCommand(ctx: BotContext): Promise<void> {
  if (!ctx.user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start для регистрации.');
    return;
  }
  await ctx.reply('Главное меню:', {
    reply_markup: mainMenuKeyboard(),
  });
}

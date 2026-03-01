import { summaryPeriodKeyboard } from '../keyboards/index.js';
import type { BotContext } from '../context.js';

export async function summaryCommand(ctx: BotContext): Promise<void> {
  if (!ctx.user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start для регистрации.');
    return;
  }
  await ctx.reply('Выберите период для саммари:', {
    reply_markup: summaryPeriodKeyboard(),
  });
}

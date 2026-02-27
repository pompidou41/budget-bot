import type { Context } from 'grammy';
import { summaryPeriodKeyboard } from '../keyboards/index.js';

export async function summaryCommand(ctx: Context): Promise<void> {
  await ctx.reply('Выберите период для саммари:', {
    reply_markup: summaryPeriodKeyboard(),
  });
}

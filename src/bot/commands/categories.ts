import type { BotContext } from '../context.js';

export async function categoriesCommand(ctx: BotContext): Promise<void> {
  const user = ctx.user;
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start для регистрации.');
    return;
  }

  const expenseList = user.expenseCategories.map((c) => `• ${c}`).join('\n');
  const incomeList = user.incomeCategories.map((c) => `• ${c}`).join('\n');

  await ctx.reply(
    `<b>Категории расходов:</b>\n${expenseList}\n\n` + `<b>Категории доходов:</b>\n${incomeList}`,
    { parse_mode: 'HTML' },
  );
}

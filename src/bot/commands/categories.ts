import type { Context } from 'grammy';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../config/categories.js';

export async function categoriesCommand(ctx: Context): Promise<void> {
  const expenseList = EXPENSE_CATEGORIES.map((c) => `• ${c}`).join('\n');
  const incomeList = INCOME_CATEGORIES.map((c) => `• ${c}`).join('\n');

  await ctx.reply(
    `<b>Категории расходов:</b>\n${expenseList}\n\n` + `<b>Категории доходов:</b>\n${incomeList}`,
    { parse_mode: 'HTML' },
  );
}

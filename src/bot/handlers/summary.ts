import type { Context } from 'grammy';
import { getSheets } from '../../sheets/client.js';
import { getTransactions, type Transaction } from '../../sheets/transactions.js';
import type { Env } from '../../config/index.js';
import { logger } from '../../logger.js';

interface PeriodRange {
  start: string;
  end: string;
  label: string;
}

function getPeriodRange(period: string): PeriodRange {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (period) {
    case 'week': {
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);

      return {
        start: formatDate(monday),
        end: formatDate(sunday),
        label: 'текущую неделю',
      };
    }
    case 'month': {
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);
      return {
        start: formatDate(firstDay),
        end: formatDate(lastDay),
        label: getMonthName(month),
      };
    }
    case 'prev_month': {
      const firstDay = new Date(year, month - 1, 1);
      const lastDay = new Date(year, month, 0);
      return {
        start: formatDate(firstDay),
        end: formatDate(lastDay),
        label: getMonthName(month - 1 < 0 ? 11 : month - 1),
      };
    }
    case 'all':
    default:
      return {
        start: '2000-01-01',
        end: '2099-12-31',
        label: 'всё время',
      };
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMonthName(month: number): string {
  const months = [
    'Январь',
    'Февраль',
    'Март',
    'Апрель',
    'Май',
    'Июнь',
    'Июль',
    'Август',
    'Сентябрь',
    'Октябрь',
    'Ноябрь',
    'Декабрь',
  ];
  return months[month] ?? 'Неизвестно';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function buildSummaryText(transactions: Transaction[], label: string): string {
  const expenses = transactions.filter((t) => t.type === 'expense');
  const income = transactions.filter((t) => t.type === 'income');

  const totalExpenses = expenses.reduce((sum, t) => sum + t.amount, 0);
  const totalIncome = income.reduce((sum, t) => sum + t.amount, 0);

  const expenseAmounts = expenses.map((t) => t.amount);
  const avgExpense = expenseAmounts.length > 0 ? totalExpenses / expenseAmounts.length : 0;
  const medianExpense = median(expenseAmounts);

  // Group expenses by category
  const byCategory = new Map<string, number>();
  for (const t of expenses) {
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amount);
  }

  const categoryLines = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amount]) => `  • ${cat}: ${amount.toLocaleString('ru-RU')}₽`)
    .join('\n');

  let text = `<b>Саммари за ${label}</b>\n\n`;
  text += `📉 <b>Расходы:</b> ${totalExpenses.toLocaleString('ru-RU')}₽\n`;
  text += `📈 <b>Доходы:</b> ${totalIncome.toLocaleString('ru-RU')}₽\n`;
  text += `💰 <b>Баланс:</b> ${(totalIncome - totalExpenses).toLocaleString('ru-RU')}₽\n\n`;

  if (expenseAmounts.length > 0) {
    text += `📊 <b>Статистика расходов:</b>\n`;
    text += `  Среднее: ${Math.round(avgExpense).toLocaleString('ru-RU')}₽\n`;
    text += `  Медиана: ${Math.round(medianExpense).toLocaleString('ru-RU')}₽\n`;
    text += `  Кол-во операций: ${expenseAmounts.length}\n\n`;
  }

  if (categoryLines) {
    text += `<b>По категориям:</b>\n${categoryLines}`;
  }

  return text;
}

export function createSummaryCallbackHandler(env: Env) {
  return async (ctx: Context): Promise<void> => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const period = data.replace('summary:', '');
    const range = getPeriodRange(period);

    try {
      const sheets = getSheets();
      const transactions = await getTransactions(
        sheets,
        env.GOOGLE_SHEETS_ID,
        range.start,
        range.end,
      );

      if (transactions.length === 0) {
        await ctx.editMessageText(`Нет записей за ${range.label}.`);
        await ctx.answerCallbackQuery();
        return;
      }

      const summaryText = buildSummaryText(transactions, range.label);
      await ctx.editMessageText(summaryText, { parse_mode: 'HTML' });
      await ctx.answerCallbackQuery();
    } catch (error) {
      logger.error({ error }, 'Failed to generate summary');
      await ctx.answerCallbackQuery('Ошибка при получении данных.');
    }
  };
}

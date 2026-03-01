import type { NextFunction } from 'grammy';
import {
  confirmTransactionKeyboard,
  wizardDateKeyboard,
  wizardTypeKeyboard,
  wizardCategoryKeyboard,
  wizardCommentKeyboard,
} from '../keyboards/index.js';
import { type Transaction } from '../../sheets/index.js';
import { formatTransactionText, setPendingTransaction } from './transaction.js';
import type { BotContext } from '../context.js';

interface WizardState {
  step: 'date' | 'type' | 'category' | 'amount' | 'comment';
  date?: string;
  type?: 'expense' | 'income';
  category?: string;
  amount?: number;
}

const wizardStates = new Map<number, WizardState>();

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]!;
}

function getYesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0]!;
}

function parseDate(input: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(input)) {
    const [day, month, year] = input.split('.').map(Number);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

async function finishWizard(ctx: BotContext, userId: number, tx: Transaction): Promise<void> {
  wizardStates.delete(userId);
  setPendingTransaction(userId, tx);
  await ctx.reply(formatTransactionText(tx), {
    parse_mode: 'HTML',
    reply_markup: confirmTransactionKeyboard(),
  });
}

export async function startWizard(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.user) return;

  wizardStates.set(userId, { step: 'date' });
  await ctx.reply('Выберите дату:', { reply_markup: wizardDateKeyboard() });
  await ctx.answerCallbackQuery();
}

export async function handleWizardDate(
  ctx: BotContext,
  dateType: 'today' | 'yesterday' | 'custom',
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = wizardStates.get(userId);
  if (!state) {
    await ctx.answerCallbackQuery('Состояние потеряно. Начните заново.');
    return;
  }

  if (dateType === 'custom') {
    state.step = 'date';
    wizardStates.set(userId, state);
    await ctx.editMessageText('Введите дату (YYYY-MM-DD или DD.MM.YYYY):');
  } else {
    state.date = dateType === 'today' ? getTodayDate() : getYesterdayDate();
    state.step = 'type';
    wizardStates.set(userId, state);
    await ctx.editMessageText('Выберите тип операции:', { reply_markup: wizardTypeKeyboard() });
  }
  await ctx.answerCallbackQuery();
}

export async function handleWizardType(
  ctx: BotContext,
  type: 'expense' | 'income',
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.user) return;

  const state = wizardStates.get(userId);
  if (!state?.date) {
    await ctx.answerCallbackQuery('Состояние потеряно.');
    return;
  }

  state.type = type;
  state.step = 'category';
  wizardStates.set(userId, state);

  const categories = type === 'expense' ? ctx.user.expenseCategories : ctx.user.incomeCategories;
  await ctx.editMessageText('Выберите категорию:', {
    reply_markup: wizardCategoryKeyboard(categories),
  });
  await ctx.answerCallbackQuery();
}

export async function handleWizardCategory(ctx: BotContext, category: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = wizardStates.get(userId);
  if (!state?.date || !state.type) {
    await ctx.answerCallbackQuery('Состояние потеряно.');
    return;
  }

  state.category = category;
  state.step = 'amount';
  wizardStates.set(userId, state);

  await ctx.editMessageText('Введите сумму (в рублях):');
  await ctx.answerCallbackQuery();
}

export async function handleWizardSkipComment(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || !ctx.user) return;

  const state = wizardStates.get(userId);
  if (!state?.date || !state.type || !state.category || !state.amount) {
    await ctx.answerCallbackQuery('Состояние потеряно.');
    return;
  }

  const tx: Transaction = {
    date: state.date,
    type: state.type,
    category: state.category,
    amount: state.amount,
    comment: '',
  };

  await finishWizard(ctx, userId, tx);
  await ctx.answerCallbackQuery();
}

export async function handleWizardText(ctx: BotContext, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await next();
    return;
  }

  const state = wizardStates.get(userId);
  if (!state) {
    await next();
    return;
  }

  const text = ctx.message?.text;
  if (!text) {
    await next();
    return;
  }

  if (state.step === 'date') {
    const date = parseDate(text.trim());
    if (!date) {
      await ctx.reply('Неверный формат даты. Используйте YYYY-MM-DD или DD.MM.YYYY.');
      return;
    }
    state.date = date;
    state.step = 'type';
    wizardStates.set(userId, state);
    await ctx.reply('Выберите тип операции:', { reply_markup: wizardTypeKeyboard() });
    return;
  }

  if (state.step === 'amount') {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('Введите корректную сумму (число больше нуля).');
      return;
    }
    state.amount = amount;
    state.step = 'comment';
    wizardStates.set(userId, state);
    await ctx.reply('Введите комментарий (или нажмите кнопку ниже для пропуска):', {
      reply_markup: wizardCommentKeyboard(),
    });
    return;
  }

  if (state.step === 'comment') {
    if (!state.date || !state.type || !state.category || !state.amount) {
      await next();
      return;
    }
    const tx: Transaction = {
      date: state.date,
      type: state.type,
      category: state.category,
      amount: state.amount,
      comment: text.trim(),
    };
    await finishWizard(ctx, userId, tx);
    return;
  }

  await next();
}

import { parseTransactionMessage } from './message-parser.js';
import { confirmTransactionKeyboard, categorySelectionKeyboard } from '../keyboards/index.js';
import { appendTransaction, updateBriefCell, type Transaction } from '../../sheets/index.js';
import { getSheets } from '../../sheets/client.js';
import { logger } from '../../logger.js';
import type { BotContext } from '../context.js';

const NOT_REGISTERED_MSG = 'Ты ещё не зарегистрирован. Нажми /start для регистрации.';

// Temporary storage for pending transactions (in-memory, per user)
const pendingTransactions = new Map<number, Transaction>();

export function createTransactionHandler() {
  return async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) {
      await ctx.reply(NOT_REGISTERED_MSG);
      return;
    }

    const text = ctx.message?.text;
    const userId = ctx.from?.id;

    if (!text || !userId) return;

    const parsed = parseTransactionMessage(text, user.expenseCategories, user.incomeCategories);

    if (!parsed) {
      await ctx.reply(
        'Не удалось распознать сообщение.\n\n' +
          'Формат: <code>Категория Сумма Комментарий</code>\n' +
          'Пример: <code>Продукты 1500 Пятёрочка</code>\n\n' +
          '/categories — список категорий',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const { transaction } = parsed;
    pendingTransactions.set(userId, transaction);

    const typeEmoji = transaction.type === 'expense' ? '📉' : '📈';
    const typeLabel = transaction.type === 'expense' ? 'Расход' : 'Доход';

    await ctx.reply(
      `${typeEmoji} <b>${typeLabel}</b>\n` +
        `Категория: ${transaction.category}\n` +
        `Сумма: ${transaction.amount}₽\n` +
        (transaction.comment ? `Комментарий: ${transaction.comment}\n` : '') +
        `Дата: ${transaction.date}\n\n` +
        `Сохранить?`,
      {
        parse_mode: 'HTML',
        reply_markup: confirmTransactionKeyboard(),
      },
    );
  };
}

export function createCallbackHandler() {
  return {
    async confirm(ctx: BotContext): Promise<void> {
      const user = ctx.user;
      if (!user) {
        await ctx.answerCallbackQuery(NOT_REGISTERED_MSG);
        return;
      }

      const userId = user.telegramId;
      const transaction = pendingTransactions.get(userId);
      if (!transaction) {
        await ctx.answerCallbackQuery('Транзакция не найдена. Попробуйте ещё раз.');
        return;
      }

      try {
        const sheets = getSheets();
        await appendTransaction(sheets, user.sheetId, transaction);
        pendingTransactions.delete(userId);

        const typeEmoji = transaction.type === 'expense' ? '📉' : '📈';
        await ctx.editMessageText(
          `${typeEmoji} Записано: ${transaction.category} — ${transaction.amount}₽` +
            (transaction.comment ? ` (${transaction.comment})` : ''),
          { parse_mode: 'HTML' },
        );
        await ctx.answerCallbackQuery('Сохранено!');

        try {
          await updateBriefCell(sheets, user.sheetId, transaction, 'add');
        } catch (briefError) {
          logger.warn({ briefError }, 'Failed to update Сводка on add');
        }
      } catch (error) {
        logger.error({ error }, 'Failed to save transaction');
        await ctx.answerCallbackQuery('Ошибка при сохранении. Попробуйте ещё раз.');
      }
    },

    async cancel(ctx: BotContext): Promise<void> {
      const userId = ctx.from?.id;
      if (!userId) return;

      pendingTransactions.delete(userId);
      await ctx.editMessageText('Отменено.');
      await ctx.answerCallbackQuery('Отменено');
    },

    async changeCategory(ctx: BotContext): Promise<void> {
      const user = ctx.user;
      if (!user) {
        await ctx.answerCallbackQuery(NOT_REGISTERED_MSG);
        return;
      }

      await ctx.editMessageText('Выберите категорию:', {
        reply_markup: categorySelectionKeyboard(user.expenseCategories),
      });
      await ctx.answerCallbackQuery();
    },

    async selectCategory(ctx: BotContext): Promise<void> {
      const user = ctx.user;
      const data = ctx.callbackQuery?.data;
      if (!user || !data) return;

      const userId = user.telegramId;
      const category = data.replace('cat:', '');
      const transaction = pendingTransactions.get(userId);

      if (!transaction) {
        await ctx.answerCallbackQuery('Транзакция не найдена.');
        return;
      }

      // Update category and type based on selection
      transaction.category = category;
      transaction.type = (user.expenseCategories as readonly string[]).includes(category)
        ? 'expense'
        : 'income';
      pendingTransactions.set(userId, transaction);

      const typeEmoji = transaction.type === 'expense' ? '📉' : '📈';
      const typeLabel = transaction.type === 'expense' ? 'Расход' : 'Доход';

      await ctx.editMessageText(
        `${typeEmoji} <b>${typeLabel}</b>\n` +
          `Категория: ${transaction.category}\n` +
          `Сумма: ${transaction.amount}₽\n` +
          (transaction.comment ? `Комментарий: ${transaction.comment}\n` : '') +
          `Дата: ${transaction.date}\n\n` +
          `Сохранить?`,
        {
          parse_mode: 'HTML',
          reply_markup: confirmTransactionKeyboard(),
        },
      );
      await ctx.answerCallbackQuery(`Категория: ${category}`);
    },

    async back(ctx: BotContext): Promise<void> {
      const userId = ctx.from?.id;
      const transaction = userId ? pendingTransactions.get(userId) : undefined;

      if (!transaction || !userId) {
        await ctx.answerCallbackQuery('Нет активной транзакции.');
        return;
      }

      const typeEmoji = transaction.type === 'expense' ? '📉' : '📈';
      const typeLabel = transaction.type === 'expense' ? 'Расход' : 'Доход';

      await ctx.editMessageText(
        `${typeEmoji} <b>${typeLabel}</b>\n` +
          `Категория: ${transaction.category}\n` +
          `Сумма: ${transaction.amount}₽\n` +
          (transaction.comment ? `Комментарий: ${transaction.comment}\n` : '') +
          `Дата: ${transaction.date}\n\n` +
          `Сохранить?`,
        {
          parse_mode: 'HTML',
          reply_markup: confirmTransactionKeyboard(),
        },
      );
      await ctx.answerCallbackQuery();
    },
  };
}

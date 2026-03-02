import { deleteLastTransaction, getTransactions, getSheets } from '../../sheets/index.js';
import { undoConfirmKeyboard, operationsMenuKeyboard } from '../keyboards/index.js';
import type { BotContext } from '../context.js';
import { logger } from '../../logger.js';
import type { Transaction } from '../../sheets/transactions.js';

function buildUndoPreviewText(tx: Transaction): string {
  const typeLabel = tx.type === 'expense' ? 'Расход' : 'Доход';
  const typeEmoji = tx.type === 'expense' ? '📉' : '📈';
  return (
    `${typeEmoji} <b>Последняя запись:</b>\n` +
    `Тип: ${typeLabel}\n` +
    `Категория: ${tx.category}\n` +
    `Сумма: ${tx.amount.toLocaleString('ru-RU')}₽\n` +
    `Дата: ${tx.date}` +
    (tx.comment ? `\nКомментарий: ${tx.comment}` : '') +
    `\n\nУдалить эту запись?`
  );
}

export function createUndoPreviewHandler() {
  return async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start для регистрации.');
      return;
    }

    const sheets = getSheets();
    const transactions = await getTransactions(sheets, user.sheetId);

    if (transactions.length === 0) {
      await ctx.reply('Нет записей для удаления.');
      return;
    }

    const last = transactions[transactions.length - 1]!;
    await ctx.reply(buildUndoPreviewText(last), {
      parse_mode: 'HTML',
      reply_markup: undoConfirmKeyboard(),
    });
  };
}

export function createUndoCallbackPreviewHandler() {
  return async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) {
      await ctx.answerCallbackQuery('Ты ещё не зарегистрирован.');
      return;
    }

    const sheets = getSheets();
    const transactions = await getTransactions(sheets, user.sheetId);

    if (transactions.length === 0) {
      await ctx.editMessageText('Нет записей для удаления.', {
        reply_markup: operationsMenuKeyboard(),
      });
      await ctx.answerCallbackQuery();
      return;
    }

    const last = transactions[transactions.length - 1]!;
    await ctx.editMessageText(buildUndoPreviewText(last), {
      parse_mode: 'HTML',
      reply_markup: undoConfirmKeyboard(),
    });
    await ctx.answerCallbackQuery();
  };
}

export function createUndoConfirmHandler() {
  return async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) {
      await ctx.answerCallbackQuery('Ты ещё не зарегистрирован.');
      return;
    }

    try {
      const sheets = getSheets();
      const deleted = await deleteLastTransaction(sheets, user.sheetId);

      if (!deleted) {
        await ctx.editMessageText('Нет записей для удаления.', {
          reply_markup: operationsMenuKeyboard(),
        });
        await ctx.answerCallbackQuery();
        return;
      }

      const typeLabel = deleted.type === 'expense' ? 'Расход' : 'Доход';
      await ctx.editMessageText(
        `Удалено: ${typeLabel} — ${deleted.category} — ${deleted.amount.toLocaleString('ru-RU')}₽` +
          (deleted.comment ? ` (${deleted.comment})` : ''),
        { reply_markup: operationsMenuKeyboard() },
      );
      await ctx.answerCallbackQuery('Удалено');
    } catch (error) {
      logger.error({ error }, 'Failed to delete last transaction');
      await ctx.answerCallbackQuery('Ошибка при удалении. Попробуйте ещё раз.');
    }
  };
}

export function createUndoCancelHandler() {
  return async (ctx: BotContext): Promise<void> => {
    await ctx.editMessageText('Отмена.', { reply_markup: operationsMenuKeyboard() });
    await ctx.answerCallbackQuery('Отменено');
  };
}

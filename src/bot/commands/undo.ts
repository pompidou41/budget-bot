import { deleteLastTransaction, getSheets } from '../../sheets/index.js';
import type { BotContext } from '../context.js';

export function createUndoCommand() {
  return async (ctx: BotContext): Promise<void> => {
    const user = ctx.user;
    if (!user) {
      await ctx.reply('Ты ещё не зарегистрирован. Нажми /start для регистрации.');
      return;
    }

    const sheets = getSheets();
    const deleted = await deleteLastTransaction(sheets, user.sheetId);

    if (!deleted) {
      await ctx.reply('Нет записей для удаления.');
      return;
    }

    const typeLabel = deleted.type === 'expense' ? 'Расход' : 'Доход';
    await ctx.reply(
      `Удалена последняя запись:\n` +
        `${typeLabel}: ${deleted.category} — ${deleted.amount}₽` +
        (deleted.comment ? ` (${deleted.comment})` : ''),
    );
  };
}

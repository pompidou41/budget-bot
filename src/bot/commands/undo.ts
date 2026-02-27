import type { Context } from 'grammy';
import { deleteLastTransaction, getSheets } from '../../sheets/index.js';
import type { Env } from '../../config/index.js';

export function createUndoCommand(env: Env) {
  return async (ctx: Context): Promise<void> => {
    const sheets = getSheets();
    const deleted = await deleteLastTransaction(sheets, env.GOOGLE_SHEETS_ID);

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

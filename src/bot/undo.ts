import type { Bot, Context } from 'grammy';
import { entryKey, type JournalEntry } from '../state/journal.js';
import { locateRow } from '../sheets/operations.js';
import type { AppDeps } from './deps.js';
import { KEPT_TEXT, liveCard, NOT_FOUND_TEXT, raceNotice } from './delete-ui.js';
import { undoConfirmKeyboard } from './keyboards.js';
import { renderDraft } from './render.js';

function formatSavedAt(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Step one: reads the sheet now and shows what is there; deletes nothing. */
async function askUndo(
  ctx: Context,
  deps: AppDeps,
  entry: JournalEntry,
  replyTo?: number,
): Promise<void> {
  const rows = await deps.repo.readRows();
  const at = locateRow(rows, entry.row, entry.values);
  if (at.status !== 'found') {
    if (at.status === 'empty') deps.journal.remove(entryKey(entry));
    const gone = 'Этой записи в таблице уже нет — ничего не удалял.';
    await ctx.reply(at.status === 'empty' ? gone : NOT_FOUND_TEXT, { parse_mode: 'HTML' });
    return;
  }
  const ref = await deps.refs.get();
  const saved = formatSavedAt(entry.savedAt, deps.env.BOT_TIMEZONE);
  const footer = `🗑 Удалить из таблицы строку ${at.row} (записана ${saved})?`;
  await ctx.reply(liveCard(rows[at.row - 1] ?? [], at.row, ref, footer), {
    parse_mode: 'HTML',
    reply_markup: undoConfirmKeyboard(entryKey(entry)),
    reply_parameters:
      replyTo === undefined
        ? undefined
        : { message_id: replyTo, allow_sending_without_reply: true },
  });
}

/** Step two: removes the row (verified before/after) and turns the card back into a draft. */
async function confirmUndo(ctx: Context, deps: AppDeps, key: number): Promise<void> {
  const entry = deps.journal.find(key);
  if (!entry) {
    await ctx.answerCallbackQuery({
      text: 'Эта запись уже отменена или слишком старая.',
      show_alert: true,
    });
    return;
  }
  const result = await deps.repo.remove([{ row: entry.row, values: entry.values }]);
  const notice = raceNotice(result);
  const done = result.removed[0];
  if (!done) {
    // A row left in place can be tried again; a row not found cannot
    const retry = result.stillPresent.length > 0;
    await ctx.editMessageText(notice ?? NOT_FOUND_TEXT, {
      parse_mode: 'HTML',
      reply_markup: retry ? undoConfirmKeyboard(key) : undefined,
    });
    await ctx.answerCallbackQuery();
    return;
  }
  deps.journal.remove(key);

  const ref = await deps.refs.get();
  const draft = deps.drafts.create(ctx.chat?.id ?? ctx.from?.id ?? 0, entry.op, {
    messageId: ctx.callbackQuery?.message?.message_id,
  });
  const footer = `🗑 Удалено из таблицы · строка ${done.row}. Можно поправить и сохранить заново.`;
  const { text, keyboard } = renderDraft(draft, ref, footer);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  await ctx.answerCallbackQuery('Удалено');
  if (notice) await ctx.reply(notice, { parse_mode: 'HTML' });
}

export function registerUndo(bot: Bot, deps: AppDeps): void {
  bot.command('undo', async (ctx) => {
    const entry = deps.journal.last();
    if (!entry) {
      await ctx.reply('Нечего отменять — бот пока ничего не записывал.');
      return;
    }
    await askUndo(ctx, deps, entry);
  });

  // Also what a button from before the two-step change sends: it leads to the confirmation
  bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
    const entry = deps.journal.find(Number((ctx.match as RegExpMatchArray)[1]));
    if (!entry) {
      await ctx.answerCallbackQuery({
        text: 'Эта запись уже отменена или слишком старая.',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await askUndo(ctx, deps, entry, ctx.callbackQuery.message?.message_id);
  });

  bot.callbackQuery(/^u:y:(\d+)$/, (ctx) =>
    confirmUndo(ctx, deps, Number((ctx.match as RegExpMatchArray)[1])),
  );

  bot.callbackQuery('u:keep', async (ctx) => {
    await ctx.editMessageText(KEPT_TEXT);
    await ctx.answerCallbackQuery('Оставил как есть');
  });
}

import type { Bot, Context } from 'grammy';
import { entryKey, type JournalEntry } from '../state/journal.js';
import type { AppDeps } from './deps.js';
import { KEPT_TEXT, NOT_FOUND_TEXT, raceNotice } from './delete-ui.js';
import { renderDraft } from './render.js';

const GONE_TEXT = 'Эта запись уже отменена или слишком старая.';

/**
 * Removes the row (verified before/after) and turns the operation back into a draft:
 * in the card the button was pressed on, or as a reply to /undo. No confirmation step —
 * the row comes back with one «Сохранить», so a wrong press costs one tap.
 */
async function undoEntry(ctx: Context, deps: AppDeps, entry: JournalEntry): Promise<void> {
  const inCard = ctx.callbackQuery?.message !== undefined;
  const result = await deps.repo.remove([{ row: entry.row, values: entry.values }]);
  const notice = raceNotice(result);
  const done = result.removed[0];
  if (!done) {
    // The card keeps its own ↩️ button, so a row left in place can be tried again from there
    await ctx.reply(notice ?? NOT_FOUND_TEXT, { parse_mode: 'HTML' });
    if (inCard) await ctx.answerCallbackQuery();
    return;
  }
  deps.journal.remove(entryKey(entry));

  const ref = await deps.refs.get();
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? 0;
  const draft = deps.drafts.create(chatId, entry.op, {
    messageId: ctx.callbackQuery?.message?.message_id,
  });
  const footer = `🗑 Удалено из таблицы · строка ${done.row}. Можно поправить и сохранить заново.`;
  const { text, keyboard } = renderDraft(draft, ref, footer);
  if (inCard) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.answerCallbackQuery('Удалено');
  } else {
    const message = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    draft.messageId = message.message_id;
  }
  if (notice) await ctx.reply(notice, { parse_mode: 'HTML' });
}

async function undoByKey(ctx: Context, deps: AppDeps): Promise<void> {
  const entry = deps.journal.find(Number((ctx.match as RegExpMatchArray)[1]));
  if (!entry) {
    await ctx.answerCallbackQuery({ text: GONE_TEXT, show_alert: true });
    return;
  }
  await undoEntry(ctx, deps, entry);
}

export function registerUndo(bot: Bot, deps: AppDeps): void {
  bot.command('undo', async (ctx) => {
    const entry = deps.journal.last();
    if (!entry) {
      await ctx.reply('Нечего отменять — бот пока ничего не записывал.');
      return;
    }
    await undoEntry(ctx, deps, entry);
  });

  bot.callbackQuery(/^u:(\d+)$/, (ctx) => undoByKey(ctx, deps));
  // Buttons of confirmations sent before the confirmation step was dropped
  bot.callbackQuery(/^u:y:(\d+)$/, (ctx) => undoByKey(ctx, deps));
  bot.callbackQuery('u:keep', async (ctx) => {
    await ctx.editMessageText(KEPT_TEXT);
    await ctx.answerCallbackQuery('Оставил как есть');
  });
}

import type { Context } from 'grammy';
import { renderCard } from '../domain/card.js';
import { locateTargets, type WrittenRow } from '../sheets/locate.js';
import { locateRow } from '../sheets/operations.js';
import type { ImportSession } from '../state/imports.js';
import type { ImportItem } from '../statement/plan.js';
import { renderImportUndoPreview } from '../statement/undo-preview.js';
import type { AppDeps } from './deps.js';
import { KEPT_TEXT, liveCard, NOT_FOUND_TEXT, raceNotice } from './delete-ui.js';
import { itemDraft } from './import-items.js';
import { confirmKeyboard } from './keyboards.js';
import { renderDraft } from './render.js';
import { importCallback, redrawImport } from './statement-flow.js';

interface Target {
  session: ImportSession;
  item: ImportItem;
}

function findTarget(session: ImportSession, row: number | undefined): Target | undefined {
  const item = session.items.find((i) => i.row === row);
  return item && { session, item };
}

function replyAbove(ctx: Context) {
  const id = ctx.callbackQuery?.message?.message_id;
  return id === undefined ? undefined : { message_id: id, allow_sending_without_reply: true };
}

type Mode = 'delete' | 'edit';
const MODES = {
  delete: {
    yes: 'y',
    label: '🗑 Да, удалить',
    footer: (row: number) => `🗑 Удалить эту строку из таблицы (строка ${row})?`,
  },
  edit: {
    yes: 'f',
    label: '✏️ Да, убрать и править',
    footer: (row: number) =>
      `✏️ Строка ${row} будет убрана из таблицы и вернётся карточкой для правки: ` +
      'в таблице её не будет, пока не сохранишь заново. Продолжить?',
  },
};

/** Step one for a written row: shows the row as the sheet holds it now; deletes nothing. */
const askItem =
  (mode: Mode) =>
  async (ctx: Context, deps: AppDeps, session: ImportSession, row?: number): Promise<void> => {
    const written = findTarget(session, row)?.item.written;
    if (!written || row === undefined) {
      await ctx.answerCallbackQuery('Эта строка уже не записана');
      return;
    }
    const rows = await deps.repo.readRows();
    const at = locateRow(rows, written.row, written.values);
    await ctx.answerCallbackQuery();
    if (at.status !== 'found') {
      await ctx.reply(NOT_FOUND_TEXT, { parse_mode: 'HTML' });
      return;
    }
    const { yes, label, footer } = MODES[mode];
    const card = liveCard(rows[at.row - 1] ?? [], at.row, await deps.refs.get(), footer(at.row));
    await ctx.reply(card, {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(
        importCallback(session, yes, row),
        importCallback(session, 'n'),
        label,
      ),
      reply_parameters: replyAbove(ctx),
    });
  };

export const askDelete = askItem('delete');
export const askEdit = askItem('edit');

/** Verified removal of a row this import wrote; the row it sat in, or null (the message says why). */
async function takeBack(ctx: Context, deps: AppDeps, target: Target): Promise<number | null> {
  const { session, item } = target;
  const written = item.written;
  if (item.status !== 'written' || !written) {
    await ctx.answerCallbackQuery('Эта строка уже не записана');
    return null;
  }
  const result = await deps.repo.remove([written]);
  const notice = raceNotice(result);
  const done = result.removed[0];
  if (!done) {
    // Nothing to offer again: the card above still has its own buttons
    await ctx.editMessageText(notice ?? NOT_FOUND_TEXT, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();
    return null;
  }
  forget(session, item, written);
  if (notice) await ctx.reply(notice, { parse_mode: 'HTML' });
  return done.row;
}

/** The row left the sheet: the item no longer counts as written. */
function forget(session: ImportSession, item: ImportItem, written: WrittenRow): void {
  delete item.written;
  session.written = session.written.filter((w) => w.values !== written.values && w !== written);
  item.status = 'skipped';
}

export async function confirmDelete(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
  row?: number,
): Promise<void> {
  const target = findTarget(session, row);
  const at = target && (await takeBack(ctx, deps, target));
  if (!target || at === null) return;
  const card = renderCard(target.item.op, await deps.refs.get(), {
    footer: `🗑 Удалено из таблицы · строка ${at}`,
  });
  await ctx.editMessageText(card, { parse_mode: 'HTML' });
  await ctx.answerCallbackQuery('Удалено');
  await redrawImport(ctx, deps, session);
}

/** The row leaves the sheet and comes back as an editable card in the confirmation message. */
export async function confirmEdit(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
  row?: number,
): Promise<void> {
  const target = findTarget(session, row);
  const at = target && (await takeBack(ctx, deps, target));
  if (!target || at === null) return;
  const draft = itemDraft(deps, target, ctx.callbackQuery?.message?.message_id);
  const footer = `↩️ Строка ${at} убрана из таблицы. Поправь и сохрани заново.`;
  const { text, keyboard } = renderDraft(draft, await deps.refs.get(), footer);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  await ctx.answerCallbackQuery();
  await redrawImport(ctx, deps, session);
}

/** «Оставить» under any import confirmation. */
export async function keepImportRows(ctx: Context): Promise<void> {
  await ctx.editMessageText(KEPT_TEXT);
  await ctx.answerCallbackQuery('Оставил как есть');
}

/** Step one of «Отменить импорт»: counts what is still intact in the sheet; deletes nothing. */
export async function askUndoImport(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
): Promise<void> {
  const { found } = locateTargets(await deps.repo.readRows(), session.written);
  await ctx.answerCallbackQuery();
  if (found.length === 0) {
    await ctx.reply(`${NOT_FOUND_TEXT}\nВ импорте записано строк: ${session.written.length}.`, {
      parse_mode: 'HTML',
    });
    return;
  }
  const text = renderImportUndoPreview(found, session.written.length, await deps.refs.get());
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(importCallback(session, 'v'), importCallback(session, 'n')),
    reply_parameters: replyAbove(ctx),
  });
}

export async function confirmUndoImport(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
): Promise<void> {
  await ctx.answerCallbackQuery('Убираю…');
  const total = session.written.length;
  const result = await deps.repo.remove(session.written);
  const gone = new Set(result.removed.map((r) => r.values));
  for (const item of session.items) {
    if (item.written && gone.has(item.written.values)) forget(session, item, item.written);
  }
  const notice = raceNotice(result);
  if (result.stillPresent.length === 0) session.stage = 'undone';
  const left = result.notFound.length;
  const text = notice
    ? `${notice}\nУдалено строк: ${result.removed.length} из ${total}.`
    : `🗑 Удалено из таблицы строк: ${result.removed.length} из ${total}.` +
      (left > 0
        ? `\nЕщё ${left} не нашёл целыми (изменены или отсортированы) — проверь их в таблице.`
        : '');
  await ctx.editMessageText(text, { parse_mode: 'HTML' });
  await redrawImport(ctx, deps, session);
}

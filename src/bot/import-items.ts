import { InlineKeyboard, type Context } from 'grammy';
import { renderCard } from '../domain/card.js';
import type { WrittenRow } from '../sheets/operations.js';
import type { ImportSession } from '../state/imports.js';
import type { ImportItem } from '../statement/plan.js';
import type { AppDeps } from './deps.js';
import type { Draft } from './drafts.js';
import { showDraft } from './show-draft.js';
import { importCallback, redrawImport } from './statement-flow.js';

/** Cards opened at once, by a button press or a reply with row numbers. */
export const CARDS_PER_PRESS = 15;

interface Target {
  session: ImportSession;
  item: ImportItem;
}

function source({ session, item }: Target): string {
  const row = session.statement.rows.find((r) => r.index === item.row);
  return [row?.description, row?.counterparty].filter(Boolean).join(' · ');
}

export function itemDraft(deps: AppDeps, target: Target, messageId?: number): Draft {
  const { session, item } = target;
  item.status = 'drafted';
  return deps.drafts.create(session.chatId, item.op, {
    duplicate: item.duplicate,
    note: `Из выписки, строка ${item.row}: ${source(target)}`,
    origin: { importId: session.id, row: item.row },
    messageId,
  });
}

/** A card of its own for a statement row; the row leaves the batch until the card is settled. */
export async function openItemDraft(
  ctx: Context,
  deps: AppDeps,
  target: Target,
  replyTo?: number,
): Promise<void> {
  await showDraft(ctx, itemDraft(deps, target), await deps.refs.get(), replyTo);
}

function linkedDraft(deps: AppDeps, { session, item }: Target): Draft | undefined {
  return deps.drafts
    .open(session.chatId)
    .find((d) => d.origin?.importId === session.id && d.origin.row === item.row);
}

async function showWritten(ctx: Context, deps: AppDeps, target: Target): Promise<string | null> {
  const { session, item } = target;
  if (!item.written) return `#${item.row} записана до обновления бота — поправь её в таблице`;
  const keyboard = new InlineKeyboard()
    .text('✏️ Исправить', importCallback(session, 'e', item.row))
    .text('🗑 Удалить из таблицы', importCallback(session, 'd', item.row));
  const footer = `✅ Записано из выписки (строка ${item.row}) · в таблице строка ${item.written.row}`;
  await ctx.reply(renderCard(item.op, await deps.refs.get(), { footer }), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  return null;
}

/** Shows one statement row; returns a line for the owner when there is no card to show. */
async function openRow(ctx: Context, deps: AppDeps, session: ImportSession, row: number) {
  const item = session.items.find((i) => i.row === row);
  if (!item) return `#${row} — такой строки в выписке нет`;
  const target = { session, item };
  if (item.status === 'recorded') return `#${row} была в таблице до импорта — правь её там`;
  if (item.status === 'written') return showWritten(ctx, deps, target);
  const open = item.status === 'drafted' ? linkedDraft(deps, target) : undefined;
  if (open?.messageId !== undefined) {
    await ctx.reply(`#${row} — карточка уже открыта`, {
      reply_parameters: { message_id: open.messageId, allow_sending_without_reply: true },
    });
    return null;
  }
  await openItemDraft(ctx, deps, target, ctx.msg?.message_id);
  return null;
}

/** Cards for the rows named in a reply to the import's summary or list. */
export async function openRows(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
  rows: number[],
): Promise<void> {
  const notes: string[] = [];
  for (const row of rows.slice(0, CARDS_PER_PRESS)) {
    const note = await openRow(ctx, deps, session, row);
    if (note) notes.push(note);
  }
  if (rows.length > CARDS_PER_PRESS) {
    notes.push(`Открыл первые ${CARDS_PER_PRESS} — остальные номера назови следующим ответом.`);
  }
  if (notes.length > 0) await ctx.reply(notes.join('\n'));
  await redrawImport(ctx, deps, session);
}

/** A statement row's card was saved (`written`) or dropped (null): the summary follows. */
export async function settleImportDraft(
  ctx: Context,
  deps: AppDeps,
  draft: Draft,
  written: WrittenRow | null,
): Promise<void> {
  const origin = draft.origin;
  if (!origin) return;
  const session = deps.statements.imports.get(origin.importId);
  const item = session?.items.find((i) => i.row === origin.row);
  // A card left over from before the row was settled another way changes nothing
  if (!session || item?.status !== 'drafted') return;
  item.op = draft.op;
  if (written) {
    item.status = 'written';
    item.written = written;
    session.written.push(written);
  } else {
    item.status = 'skipped';
  }
  if (session.stage === 'review' || session.stage === 'done') {
    await redrawImport(ctx, deps, session);
  }
}

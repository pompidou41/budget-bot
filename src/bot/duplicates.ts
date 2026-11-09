import { InlineKeyboard, type Bot } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import {
  describeMatch,
  findDuplicates,
  sheetMovements,
  summarize,
  type Existing,
} from '../domain/duplicates.js';
import type { Operation } from '../domain/operation.js';
import type { Reference } from '../domain/reference.js';
import { logger } from '../logger.js';
import type { AppDeps } from './deps.js';
import type { Draft } from './drafts.js';
import { showDraft } from './show-draft.js';
import { ignoreNotModified } from './telegram.js';

const RELEASE = /^h:([0-9a-f]+)$/;

/** Rows of «Операции» to compare new operations against. A failed read must not block input. */
export async function recordedMovements(deps: Pick<AppDeps, 'repo'>): Promise<Existing[]> {
  try {
    return sheetMovements(await deps.repo.readRows());
  } catch (error) {
    logger.warn({ error }, 'Failed to read operations for the duplicate check');
    return [];
  }
}

export interface Placed {
  op: Operation;
  /** HTML description of the operation this one repeats or may repeat. */
  duplicate?: string;
  /** An exact repeat: kept off-screen until the owner asks for it. */
  held: boolean;
}

/**
 * Checks parsed operations against the sheet and the chat's open drafts. Call it and create the
 * drafts without awaiting in between, so a second screenshot sees the first one's drafts.
 */
export function placeOperations(
  ops: Operation[],
  recorded: Existing[],
  openDrafts: Draft[],
  ref: Reference,
): Placed[] {
  const drafts = openDrafts.map(
    (draft): Existing => ({ op: draft.op, source: { kind: 'draft', draftId: draft.id } }),
  );
  const found = findDuplicates(ops, [...recorded, ...drafts]);
  return ops.map((op, i) => {
    const duplicate = found[i];
    return {
      op,
      held: duplicate?.kind === 'exact',
      duplicate: duplicate ? describeMatch(duplicate.match, ref) : undefined,
    };
  });
}

/** One message for every exact repeat, each with its own «➕ всё равно» button. */
export function heldView(
  held: Draft[],
  ref: Reference,
  header?: string,
): { text: string; keyboard: InlineKeyboard } {
  const lines = held.map(
    (draft, i) => `${i + 1}. ${summarize(draft.op, ref)}\n    → ${draft.duplicate ?? ''}`,
  );
  const keyboard = new InlineKeyboard();
  held.forEach((draft, i) => {
    keyboard.text(`➕ ${i + 1} всё равно`, `h:${draft.id}`);
    if (i % 2 === 1) keyboard.row();
  });
  const title = '⏭ <b>Уже есть — не добавляю:</b>';
  return {
    text: [header, title, ...lines].filter(Boolean).join('\n'),
    keyboard,
  };
}

function withoutButton(rows: InlineKeyboardButton[][], data: string): InlineKeyboardButton[][] {
  return rows
    .map((row) =>
      row.filter((button) => !('callback_data' in button && button.callback_data === data)),
    )
    .filter((row) => row.length > 0);
}

export function registerDuplicateHandlers(bot: Bot, deps: AppDeps): void {
  bot.callbackQuery(RELEASE, async (ctx) => {
    const [, id = ''] = ctx.match as RegExpMatchArray;
    const draft = deps.drafts.get(id);
    if (!draft?.held) {
      await ctx.answerCallbackQuery({
        text: 'Это уже неактуально — отправь операцию заново.',
        show_alert: true,
      });
      return;
    }
    draft.held = false;
    await ctx.answerCallbackQuery();

    const message = ctx.callbackQuery.message;
    await showDraft(ctx, draft, await deps.refs.get(), message?.message_id);
    if (!message?.reply_markup) return;
    const rows = withoutButton(message.reply_markup.inline_keyboard, ctx.callbackQuery.data);
    await ignoreNotModified(ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard(rows) }));
  });
}

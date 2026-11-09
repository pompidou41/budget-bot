import type { Context } from 'grammy';
import type { Reference } from '../domain/reference.js';
import type { Draft } from './drafts.js';
import { renderDraft } from './render.js';
import { ignoreNotModified } from './telegram.js';

/** Sends the draft's card (as a reply to `replyTo`, if given), or redraws the one it already has. */
export async function showDraft(
  ctx: Context,
  draft: Draft,
  ref: Reference,
  replyTo?: number,
): Promise<void> {
  const { text, keyboard } = renderDraft(draft, ref);
  if (draft.messageId === undefined) {
    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
    });
    draft.messageId = message.message_id;
    return;
  }
  await ignoreNotModified(
    ctx.api.editMessageText(draft.chatId, draft.messageId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }),
  );
}

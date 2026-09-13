import { GrammyError, type Api, type InlineKeyboard } from 'grammy';
import { logger } from '../logger.js';
import { stripHtml } from './telegram.js';

/**
 * Rich messages support a different tag set than ordinary Telegram HTML — tables,
 * `<details>`, headings, in-text `<tg-button>` — so a view carries both renderings.
 * `html` is what the reader sees when rich rendering is off or rejected.
 */
export interface RichView {
  rich: string;
  html: string;
  /** Buttons for the fallback; in rich mode they live inside `rich` as `<tg-button>`. */
  keyboard?: InlineKeyboard;
}

export type RenderMode = 'rich' | 'html';

/**
 * Escapes text for rich HTML. The API accepts only a short list of named entities, so
 * quotes go out as numeric ones — they must be escaped because our text also lands inside
 * attributes such as `<tg-button data="…">`.
 */
export function escapeRich(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

function isRichRejected(error: unknown): error is GrammyError {
  if (!(error instanceof GrammyError)) return false;
  // Old clients, a disabled feature or malformed blocks all surface as a 400 on this call
  return error.error_code === 400;
}

/** Sends a view, falling back to ordinary HTML if rich rendering is off or refused. */
export async function sendView(
  api: Api,
  chatId: number,
  view: RichView,
  mode: RenderMode,
  replyTo?: number,
): Promise<number> {
  const replyParameters = replyTo === undefined ? undefined : { message_id: replyTo };

  if (mode === 'rich') {
    try {
      const sent = await api.sendRichMessage(
        chatId,
        { html: view.rich },
        { reply_parameters: replyParameters },
      );
      return sent.message_id;
    } catch (error) {
      if (!isRichRejected(error)) throw error;
      logger.warn({ description: error.description }, 'Rich message rejected, sending HTML');
    }
  }

  const sent = await api.sendMessage(chatId, view.html, {
    parse_mode: 'HTML',
    reply_markup: view.keyboard,
    reply_parameters: replyParameters,
  });
  return sent.message_id;
}

/** Replaces a message with a view. Mirrors {@link sendView}, including the fallback. */
export async function editView(
  api: Api,
  chatId: number,
  messageId: number,
  view: RichView,
  mode: RenderMode,
): Promise<void> {
  if (mode === 'rich') {
    try {
      await api.editMessageText(chatId, messageId, { html: view.rich });
      return;
    } catch (error) {
      if (!isRichRejected(error)) throw error;
      if (error.description.includes('message is not modified')) return;
      logger.warn({ description: error.description }, 'Rich edit rejected, editing as HTML');
    }
  }

  try {
    await api.editMessageText(chatId, messageId, view.html, {
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
    });
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    if (error.description.includes('message is not modified')) return;
    if (!error.description.includes('parse entities')) throw error;

    logger.warn({ description: error.description }, 'Telegram rejected HTML, sending plain text');
    await api.editMessageText(chatId, messageId, stripHtml(view.html), {
      reply_markup: view.keyboard,
    });
  }
}

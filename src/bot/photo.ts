import { GrammyError, InputFile, type Api, type InlineKeyboard } from 'grammy';
import type { MessageEntity } from 'grammy/types';

/**
 * A rendered picture with its caption and buttons. The picture counterpart of {@link RichView}:
 * a photo cannot carry rich markup, so its buttons are an ordinary inline keyboard.
 */
export interface PhotoView {
  png: Buffer;
  /** Telegram HTML; at most 1024 characters, the limit for a photo caption. */
  caption?: string;
  /**
   * Set when `caption` is plain text with these entities, as Telegram hands a message's caption
   * back (empty if it has none): the recap text under a picture that is redrawn. Wins over HTML.
   */
  captionEntities?: MessageEntity[];
  keyboard?: InlineKeyboard;
}

const FILE_NAME = 'report.png';

function captionOptions(view: PhotoView) {
  if (view.captionEntities)
    return { caption: view.caption, caption_entities: view.captionEntities };
  return view.caption ? { caption: view.caption, parse_mode: 'HTML' as const } : {};
}

export async function sendPhotoView(
  api: Api,
  chatId: number,
  view: PhotoView,
  replyTo?: number,
): Promise<number> {
  const sent = await api.sendPhoto(chatId, new InputFile(view.png, FILE_NAME), {
    ...captionOptions(view),
    reply_markup: view.keyboard,
    reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
  });
  return sent.message_id;
}

/** Swaps the picture (and buttons) of a photo message; pressing the same button twice is a no-op. */
export async function editPhotoView(
  api: Api,
  chatId: number,
  messageId: number,
  view: PhotoView,
): Promise<void> {
  try {
    await api.editMessageMedia(
      chatId,
      messageId,
      { type: 'photo', media: new InputFile(view.png, FILE_NAME), ...captionOptions(view) },
      { reply_markup: view.keyboard },
    );
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes('message is not modified')) {
      return;
    }
    throw error;
  }
}

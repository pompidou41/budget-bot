import { GrammyError, InlineKeyboard, InputFile, type Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { editPhotoView, sendPhotoView } from '../src/bot/photo.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function apiError(description: string): GrammyError {
  return new GrammyError('Call failed', { ok: false, error_code: 400, description }, 'x', {});
}

describe('sendPhotoView', () => {
  it('sends the picture with an HTML caption, the keyboard and a reply target', async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 77 });
    const keyboard = new InlineKeyboard().text('ok', 'ri:b8:-:r');

    const id = await sendPhotoView(
      { sendPhoto } as unknown as Api,
      5,
      { png, caption: '<b>Итоги</b>', keyboard },
      12,
    );

    expect(id).toBe(77);
    const [chatId, file, options] = sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(5);
    expect(file).toBeInstanceOf(InputFile);
    expect(options).toMatchObject({
      caption: '<b>Итоги</b>',
      parse_mode: 'HTML',
      reply_markup: keyboard,
      reply_parameters: { message_id: 12 },
    });
  });

  it('sends no caption and no reply when there are none', async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 1 });

    await sendPhotoView({ sendPhoto } as unknown as Api, 5, { png });

    const options = sendPhoto.mock.calls[0]![2];
    expect(options.caption).toBeUndefined();
    expect(options.parse_mode).toBeUndefined();
    expect(options.reply_parameters).toBeUndefined();
  });
});

describe('editPhotoView', () => {
  it('replaces the media and the buttons of the same message', async () => {
    const editMessageMedia = vi.fn().mockResolvedValue(true);
    const keyboard = new InlineKeyboard().text('ok', 'ri:b8:-:r');

    await editPhotoView({ editMessageMedia } as unknown as Api, 5, 9, { png, keyboard });

    const [chatId, messageId, media, extra] = editMessageMedia.mock.calls[0]!;
    expect([chatId, messageId]).toEqual([5, 9]);
    expect(media).toMatchObject({ type: 'photo' });
    expect(media.media).toBeInstanceOf(InputFile);
    expect(extra).toEqual({ reply_markup: keyboard });
  });

  it('keeps a caption as Telegram sent it, entities and all, without parsing it again', async () => {
    const editMessageMedia = vi.fn().mockResolvedValue(true);
    const entities = [{ type: 'bold' as const, offset: 0, length: 5 }];

    await editPhotoView({ editMessageMedia } as unknown as Api, 5, 9, {
      png,
      caption: 'Итоги <1–8> & co',
      captionEntities: entities,
    });

    const media = editMessageMedia.mock.calls[0]![2];
    expect(media).toMatchObject({ caption: 'Итоги <1–8> & co', caption_entities: entities });
    expect(media.parse_mode).toBeUndefined();
  });

  it('shrugs off «message is not modified», but not other errors', async () => {
    const same = vi.fn().mockRejectedValue(apiError('Bad Request: message is not modified: …'));
    await expect(
      editPhotoView({ editMessageMedia: same } as unknown as Api, 5, 9, { png }),
    ).resolves.toBeUndefined();

    const gone = vi.fn().mockRejectedValue(apiError('Bad Request: message to edit not found'));
    await expect(
      editPhotoView({ editMessageMedia: gone } as unknown as Api, 5, 9, { png }),
    ).rejects.toThrow('Call failed');
  });
});

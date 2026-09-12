import type { Bot, Context } from 'grammy';
import type { ParseInput } from '../../ai/parse.js';
import { escapeHtml } from '../../domain/format.js';
import { applyDefaultAccount } from '../../domain/operation.js';
import type { Reference } from '../../domain/reference.js';
import { logger } from '../../logger.js';
import type { AppDeps } from '../deps.js';
import { applyInput } from '../draft-actions.js';
import type { Draft } from '../drafts.js';
import { askInsteadKeyboard } from '../keyboards.js';
import { renderDraft } from '../render.js';
import { describeError, downloadTelegramFile, ignoreNotModified } from '../telegram.js';
import { transcribeVoice, transcriptLine } from '../voice.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function showDraft(ctx: Context, draft: Draft, ref: Reference): Promise<void> {
  const { text, keyboard } = renderDraft(draft, ref);
  if (draft.messageId === undefined) {
    const message = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
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

/** Note under the card: the model's own remark plus a warning about an auto-filled account. */
function draftNote(aiNote: string | null, filledAccount: string | null): string | undefined {
  const lines = [
    aiNote,
    filledAccount && `Счёт не назван — подставил ${filledAccount} из /settings.`,
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

async function createDrafts(
  ctx: Context,
  deps: AppDeps,
  input: ParseInput,
  transcript?: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const placeholderText = transcript
    ? `${transcriptLine(transcript)}\n\n⏳ Разбираю…`
    : '⏳ Разбираю…';
  const placeholder = await ctx.reply(placeholderText, {
    parse_mode: 'HTML',
    reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id } : undefined,
  });

  try {
    const ref = await deps.refs.get();
    const settings = deps.settings.get();
    const result = await deps.parser.parse(input, ref, settings.aliases);

    if (result.operations.length === 0) {
      const note = result.note ? `\n${escapeHtml(result.note)}` : '';
      await ctx.api.editMessageText(
        chatId,
        placeholder.message_id,
        `🤷 Не нашёл операций.${note}\n\nПопробуй сформулировать иначе или /add.`,
        // The escape hatch reads the question back off the replied-to message, so it is only
        // offered when there is one to read — a voice note carries no text to recover.
        { parse_mode: 'HTML', reply_markup: input.text ? askInsteadKeyboard() : undefined },
      );
      return;
    }

    for (const [i, op] of result.operations.entries()) {
      const withDefault = applyDefaultAccount(op, settings.defaultAccount, ref);
      const filled = withDefault.account !== op.account ? withDefault.account : null;
      const draft = deps.drafts.create(chatId, withDefault, {
        transcript: i === 0 ? transcript : undefined,
        note: draftNote(i === 0 ? result.note : null, filled),
        // The first card replaces the "⏳ Разбираю…" placeholder
        messageId: i === 0 ? placeholder.message_id : undefined,
      });
      await showDraft(ctx, draft, ref);
    }
  } catch (error) {
    logger.error({ error }, 'Failed to parse message');
    await ctx.api.editMessageText(
      chatId,
      placeholder.message_id,
      `⚠️ Не получилось разобрать: ${escapeHtml(describeError(error))}\n\nПопробуй ещё раз или /add.`,
      { parse_mode: 'HTML' },
    );
  }
}

async function editDraft(
  ctx: Context,
  deps: AppDeps,
  draft: Draft,
  instruction: string,
): Promise<void> {
  await ctx.replyWithChatAction('typing');
  const ref = await deps.refs.get();

  try {
    const result = await deps.parser.edit(draft.op, instruction, ref, deps.settings.get().aliases);
    const updated = result.operations[0];
    if (!updated) {
      await ctx.reply('Не понял правку 🤷 Попробуй сказать иначе.');
      return;
    }
    draft.op = updated;
    draft.note = result.note ?? undefined;
    draft.view = { kind: 'card' };
    draft.wizard = false;
    await showDraft(ctx, draft, ref);
    await ctx.react('👌').catch(() => undefined);
  } catch (error) {
    logger.error({ error }, 'Failed to apply draft edit');
    await ctx.reply(`⚠️ Не получилось применить правку: ${describeError(error)}`);
  }
}

async function fillInput(ctx: Context, deps: AppDeps, draft: Draft, text: string): Promise<void> {
  const ref = await deps.refs.get();
  const error = applyInput(draft, ref, text, deps.env.BOT_TIMEZONE);
  if (error) {
    await ctx.reply(error);
    return;
  }
  // The answer is now part of the card; keep the chat tidy
  await ctx.deleteMessage().catch(() => undefined);
  await showDraft(ctx, draft, ref);
}

async function handleText(
  ctx: Context,
  deps: AppDeps,
  text: string,
  transcript?: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const replyTo = ctx.msg?.reply_to_message?.message_id;
  if (replyTo !== undefined) {
    const draft = deps.drafts.byMessage(chatId, replyTo);
    if (draft) {
      await editDraft(ctx, deps, draft, text);
      return;
    }
    if (deps.journal.findByMessage(replyTo)) {
      await ctx.reply(
        'Эта операция уже записана. Нажми «↩️ Отменить» под ней, поправь и сохрани заново.',
      );
      return;
    }
  }

  // Typed answers to wizard questions; voice always starts a new operation
  const awaiting = transcript === undefined ? deps.drafts.awaitingInput(chatId) : undefined;
  if (awaiting) {
    await fillInput(ctx, deps, awaiting, text);
    return;
  }

  await createDrafts(ctx, deps, { text }, transcript);
}

async function handleImage(ctx: Context, deps: AppDeps, mimeType: string): Promise<void> {
  await ctx.replyWithChatAction('typing');

  let imageDataUrl: string;
  try {
    const image = await downloadTelegramFile(ctx, deps.env.BOT_TOKEN);
    imageDataUrl = `data:${mimeType};base64,${Buffer.from(image).toString('base64')}`;
  } catch (error) {
    logger.error({ error }, 'Failed to download image');
    await ctx.reply('⚠️ Не удалось скачать картинку — попробуй ещё раз.');
    return;
  }

  await createDrafts(ctx, deps, { text: ctx.msg?.caption, imageDataUrl });
}

export function registerInputHandlers(bot: Bot, deps: AppDeps): void {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Не знаю такой команды — /help');
      return;
    }
    await handleText(ctx, deps, text);
  });

  bot.on('message:voice', async (ctx) => {
    const transcript = await transcribeVoice(ctx, deps);
    if (transcript === null) return;
    await handleText(ctx, deps, transcript, transcript);
  });

  bot.on('message:photo', (ctx) => handleImage(ctx, deps, 'image/jpeg'));

  bot.on('message:document', async (ctx) => {
    const { mime_type: mimeType, file_size: size } = ctx.message.document;
    if (!mimeType?.startsWith('image/')) {
      await ctx.reply('Понимаю текст, голосовые и картинки.');
      return;
    }
    if (size !== undefined && size > MAX_IMAGE_BYTES) {
      await ctx.reply('Картинка больше 10 МБ — пришли поменьше.');
      return;
    }
    await handleImage(ctx, deps, mimeType);
  });
}

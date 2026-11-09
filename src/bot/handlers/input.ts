import type { Bot, Context } from 'grammy';
import type { ParseInput, ParseResult } from '../../ai/parse.js';
import type { Existing } from '../../domain/duplicates.js';
import { escapeHtml } from '../../domain/format.js';
import { applyDefaultAccount } from '../../domain/operation.js';
import { logger } from '../../logger.js';
import type { AppDeps } from '../deps.js';
import { applyInput } from '../draft-actions.js';
import type { Draft } from '../drafts.js';
import { askInsteadKeyboard, RETRY_CALLBACK, retryKeyboard } from '../keyboards.js';
import { heldView, placeOperations, recordedMovements } from '../duplicates.js';
import { showDraft } from '../show-draft.js';
import { describeError, downloadTelegramFile } from '../telegram.js';
import { spokenText, transcriptLine } from '../voice.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Inputs that failed to parse, keyed by the message carrying the retry button. In memory only:
// a restart drops them and the button then asks to resend. Bounded, since an input may be an image.
const MAX_RETRIES_KEPT = 10;
const failedInputs = new Map<string, { input: ParseInput; transcript?: string }>();

function retryKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function rememberFailed(chatId: number, messageId: number, input: ParseInput, transcript?: string) {
  failedInputs.set(retryKey(chatId, messageId), { input, transcript });
  for (const key of failedInputs.keys()) {
    if (failedInputs.size <= MAX_RETRIES_KEPT) break;
    failedInputs.delete(key);
  }
}

/** Note under the card: the model's own remark plus a warning about an auto-filled account. */
function draftNote(aiNote: string | null, filledAccount: string | null): string | undefined {
  const lines = [
    aiNote,
    filledAccount && `Счёт не назван — подставил ${filledAccount} из /settings.`,
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Drafts for parsed operations: new ones as cards, the first in place of «⏳ Разбираю…»;
 * exact repeats of recorded ones gathered in a single «⏭ Уже есть» message.
 */
async function presentOperations(
  ctx: Context,
  deps: AppDeps,
  result: ParseResult,
  recorded: Existing[],
  placeholderId: number,
  transcript?: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const ref = await deps.refs.get();
  const { defaultAccount } = deps.settings.get();

  // No await until the drafts exist: the next screenshot of an album must be checked against them
  const ops = result.operations.map((op) => applyDefaultAccount(op, defaultAccount, ref));
  const drafts = placeOperations(ops, recorded, deps.drafts.open(chatId), ref).map(
    ({ op, held, duplicate }, i) =>
      deps.drafts.create(chatId, op, {
        held,
        duplicate,
        note: draftNote(null, op.account !== result.operations[i]?.account ? op.account : null),
      }),
  );

  const shown = drafts.filter((draft) => !draft.held);
  const held = drafts.filter((draft) => draft.held);
  const [first] = shown;
  if (first) {
    first.transcript = transcript;
    first.note = [result.note, first.note].filter(Boolean).join('\n') || undefined;
    first.messageId = placeholderId;
  }
  for (const draft of shown) await showDraft(ctx, draft, ref);
  if (held.length === 0) return;

  const header = !first && transcript ? `${transcriptLine(transcript)}\n` : undefined;
  const { text, keyboard } = heldView(held, ref, header);
  if (first) await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  else {
    await ctx.api.editMessageText(chatId, placeholderId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
}

async function createDrafts(
  ctx: Context,
  deps: AppDeps,
  input: ParseInput,
  transcript?: string,
  /** The «⏳ Разбираю…» message of an earlier attempt, reused by the retry button. */
  retryMessageId?: number,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const placeholderText = transcript
    ? `${transcriptLine(transcript)}\n\n⏳ Разбираю…`
    : '⏳ Разбираю…';
  const placeholder =
    retryMessageId === undefined
      ? await ctx.reply(placeholderText, {
          parse_mode: 'HTML',
          reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id } : undefined,
        })
      : { message_id: retryMessageId };

  try {
    const ref = await deps.refs.get();
    const settings = deps.settings.get();
    // Read alongside the AI call: the sheet answers well within the model's time
    const recorded = recordedMovements(deps);
    const result = await deps.parser.parse(input, ref, settings.notes);

    if (result.operations.length === 0) {
      const note = result.note ? `\n${escapeHtml(result.note)}` : '';
      await ctx.api.editMessageText(
        chatId,
        placeholder.message_id,
        `${transcript ? `${transcriptLine(transcript)}\n\n` : ''}🤷 Не нашёл операций.${note}\n\nПопробуй сформулировать иначе или /add.`,
        // The escape hatch reads the question back: off the replied-to message when it was typed,
        // off the «🎙» line above when it was spoken — Telegram keeps no text on a voice message
        { parse_mode: 'HTML', reply_markup: input.text ? askInsteadKeyboard() : undefined },
      );
      return;
    }

    const recordedNow = await recorded;
    await presentOperations(ctx, deps, result, recordedNow, placeholder.message_id, transcript);
  } catch (error) {
    logger.error({ error }, 'Failed to parse message');
    rememberFailed(chatId, placeholder.message_id, input, transcript);
    await ctx.api.editMessageText(
      chatId,
      placeholder.message_id,
      `${transcript ? `${transcriptLine(transcript)}\n\n` : ''}⚠️ Не получилось разобрать: ${escapeHtml(describeError(error))}\n\nПопробуй ещё раз или /add.`,
      { parse_mode: 'HTML', reply_markup: retryKeyboard() },
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
    const result = await deps.parser.edit(draft.op, instruction, ref, deps.settings.get().notes);
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

  // Answers to wizard steps and card inputs — typed or spoken alike
  const awaiting = deps.drafts.awaitingInput(chatId);
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
  bot.callbackQuery(RETRY_CALLBACK, async (ctx) => {
    const message = ctx.callbackQuery.message;
    const failed = message && failedInputs.get(retryKey(message.chat.id, message.message_id));
    if (!message || !failed) {
      await ctx.answerCallbackQuery({
        text: 'Это сообщение устарело — отправь заново.',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    failedInputs.delete(retryKey(message.chat.id, message.message_id));
    await createDrafts(ctx, deps, failed.input, failed.transcript, message.message_id);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Не знаю такой команды — /help');
      return;
    }
    // A voice message arrives here already transcribed; the transcript is still shown on the card
    await handleText(ctx, deps, text, spokenText(ctx) === undefined ? undefined : text);
  });

  bot.on('message:photo', (ctx) => handleImage(ctx, deps, 'image/jpeg'));

  bot.on('message:document', async (ctx) => {
    const { mime_type: mimeType, file_size: size } = ctx.message.document;
    if (!mimeType?.startsWith('image/')) {
      await ctx.reply('Понимаю текст, голосовые, картинки и выписки PDF или XLSX.');
      return;
    }
    if (size !== undefined && size > MAX_IMAGE_BYTES) {
      await ctx.reply('Картинка больше 10 МБ — пришли поменьше.');
      return;
    }
    await handleImage(ctx, deps, mimeType);
  });
}

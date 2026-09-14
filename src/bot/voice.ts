import type { Context, MiddlewareFn } from 'grammy';
import { escapeHtml } from '../domain/format.js';
import { logger } from '../logger.js';
import type { AppDeps } from './deps.js';
import { downloadTelegramFile } from './telegram.js';

const MAX_VOICE_SECONDS = 120;
// Whisper prompt biases recognition towards the vocabulary of the owner's accounts
const WHISPER_PROMPT =
  'Учёт личных финансов: расходы, доходы, переводы. ' +
  'Т-Банк, Альфа-Банк, Газпромбанк, Ренессанс, Bybit, USDT, рубли, доллары.';

/**
 * Transcribes the voice message in the current update. Returns null when it could not be
 * transcribed — the user has already been told why, so the caller just stops.
 */
export async function transcribeVoice(ctx: Context, deps: AppDeps): Promise<string | null> {
  const voice = ctx.msg?.voice;
  if (!voice) return null;

  if (voice.duration > MAX_VOICE_SECONDS) {
    await ctx.reply('Голосовое длиннее 2 минут — запиши покороче.');
    return null;
  }
  await ctx.replyWithChatAction('typing');

  try {
    const audio = await downloadTelegramFile(ctx, deps.env.BOT_TOKEN);
    // Telegram stores voice as .oga; Groq recognises the same Opus stream by .ogg
    return await deps.transcribe(audio, 'voice.ogg', WHISPER_PROMPT);
  } catch (error) {
    logger.error({ error }, 'Voice transcription failed');
    await ctx.reply('⚠️ Не удалось распознать голосовое — попробуй ещё раз или напиши текстом.');
    return null;
  }
}

/** Shows what the bot heard, so a mis-transcription is obvious before anything acts on it. */
export function transcriptLine(transcript: string): string {
  return `🎙 <i>${escapeHtml(transcript)}</i>`;
}

/**
 * Voice is just another way to type. The transcript becomes the message text before any handler
 * sees the update, so every text path works for voice exactly as for text: a new operation, an
 * answer to a wizard step, a comment, a note for the AI, a follow-up question, a correction by
 * reply. grammY checks `message:text` filters as each middleware is reached, so everything
 * registered after this sees the transcript as ordinary text.
 */
export function voiceAsText(deps: AppDeps): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const message = ctx.message;
    if (!message?.voice) {
      await next();
      return;
    }
    const transcript = await transcribeVoice(ctx, deps);
    if (transcript === null) return;
    message.text = transcript;
    await next();
  };
}

/** The transcript when the current message was spoken, undefined when it was typed. */
export function spokenText(ctx: Context): string | undefined {
  return ctx.msg?.voice ? ctx.msg.text : undefined;
}

/**
 * Reads a transcript back from a bot message that starts with {@link transcriptLine}. Telegram
 * keeps no text on the voice message itself, so this is the only place a spoken question survives.
 */
export function transcriptFrom(text: string | undefined): string | undefined {
  return text?.match(/^🎙 (.+)$/mu)?.[1]?.trim();
}

import type { Context } from 'grammy';
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

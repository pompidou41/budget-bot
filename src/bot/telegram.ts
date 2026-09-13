import { GrammyError, type Api, type Context } from 'grammy';
import { logger } from '../logger.js';

const DOWNLOAD_TIMEOUT_MS = 30_000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
};

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * Replaces a message with HTML we built ourselves. Everything user- or model-supplied is
 * escaped upstream, so a rejected entity means our own markup broke — send it as plain
 * text rather than losing the answer.
 */
export async function editHtml(
  api: Api,
  chatId: number,
  messageId: number,
  html: string,
): Promise<void> {
  try {
    await api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' });
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    if (error.description.includes('message is not modified')) return;
    if (!error.description.includes('parse entities')) throw error;

    logger.warn({ description: error.description }, 'Telegram rejected HTML, sending plain text');
    await api.editMessageText(chatId, messageId, stripHtml(html));
  }
}

/** Telegram rejects edits that don't change anything; that is not an error for us. */
export async function ignoreNotModified(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes('message is not modified')) {
      return;
    }
    throw error;
  }
}

/** Downloads the file attached to the current message (largest size for photos). */
export async function downloadTelegramFile(ctx: Context, token: string): Promise<ArrayBuffer> {
  const file = await ctx.getFile();
  if (!file.file_path) throw new Error('Telegram did not return file_path');

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return response.arrayBuffer();
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'неизвестная ошибка';
}

/**
 * Runs slow AI work without holding the update queue. grammY's built-in polling handles
 * updates one at a time, so a minute of thinking would otherwise freeze every other message —
 * including the expense the owner is trying to add meanwhile.
 */
export function inBackground(task: Promise<unknown>, what: string): void {
  task.catch((error: unknown) => logger.error({ error }, `Background task failed: ${what}`));
}

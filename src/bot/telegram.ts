import { GrammyError, type Context } from 'grammy';

const DOWNLOAD_TIMEOUT_MS = 30_000;

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

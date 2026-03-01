import type { sheets_v4 } from 'googleapis';
import { logger } from '../logger.js';

export type AccessCheckResult = { ok: true; title: string } | { ok: false; error: string };

export async function verifySheetAccess(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<AccessCheckResult> {
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title',
    });
    const title = response.data.properties?.title ?? 'Без названия';
    return { ok: true, title };
  } catch (error: unknown) {
    const status = (error as { code?: number }).code;
    logger.warn({ spreadsheetId, status }, 'Sheet access check failed');

    if (status === 403 || status === 404) {
      return { ok: false, error: 'no_access' };
    }
    return { ok: false, error: 'unknown' };
  }
}

export function extractSheetIdFromUrl(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

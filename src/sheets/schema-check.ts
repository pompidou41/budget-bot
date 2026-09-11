import type { sheets_v4 } from 'googleapis';
import { OPERATIONS_SHEET } from './operations.js';

/** Headers of «Операции»!A1:K1 — the only columns the bot writes. */
export const EXPECTED_HEADERS = [
  'Дата',
  'Тип',
  'Счёт',
  'Сумма',
  'Счёт куда',
  'Получено',
  'Категория',
  'Подкатегория',
  'Комментарий',
  'Разовая',
  'Курс (ручной)',
];

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function compareHeaders(actual: unknown[]): string[] {
  return EXPECTED_HEADERS.flatMap((expected, i) =>
    normalizeHeader(actual[i]) === normalizeHeader(expected)
      ? []
      : [
          `${String.fromCharCode(65 + i)}1: ожидалось «${expected}», ` +
            `в таблице «${String(actual[i] ?? '')}»`,
        ],
  );
}

/** Returns mismatches between the sheet header and EXPECTED_HEADERS (empty = OK). */
export async function checkOperationsHeader(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<string[]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${OPERATIONS_SHEET}!A1:K1`,
  });
  return compareHeaders((response.data.values?.[0] ?? []) as unknown[]);
}

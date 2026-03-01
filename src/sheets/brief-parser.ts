import type { sheets_v4 } from 'googleapis';
import { logger } from '../logger.js';

export interface BriefCategories {
  expenseCategories: string[];
  incomeCategories: string[];
}

const EXPENSE_MARKER = 'расходы итого:';
const INCOME_MARKER = 'доход итого:';
const SKIP_LABELS = ['месяц'];

function extractSectionCategories(cells: string[], markerIndex: number): string[] {
  const result: string[] = [];

  for (let i = markerIndex + 1; i < cells.length; i++) {
    const cell = cells[i]!.trim();

    if (!cell) break; // empty row = end of section

    const lower = cell.toLowerCase();

    // Stop at the next section marker
    if (lower.endsWith('итого:')) break;

    // Skip subtotal/summary rows
    if (SKIP_LABELS.includes(lower)) continue;

    result.push(cell);
  }

  return result;
}

export async function parseBriefCategories(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<BriefCategories | null> {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Сводка!A:A',
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      logger.warn({ spreadsheetId }, 'Сводка sheet is empty or not found');
      return null;
    }

    const cells: string[] = rows.map((row) => (row[0] as string | undefined) ?? '');

    let expenseMarkerIdx = -1;
    let incomeMarkerIdx = -1;

    for (let i = 0; i < cells.length; i++) {
      const lower = cells[i]!.toLowerCase().trim();
      if (lower === EXPENSE_MARKER) expenseMarkerIdx = i;
      else if (lower === INCOME_MARKER) incomeMarkerIdx = i;
    }

    if (expenseMarkerIdx === -1 && incomeMarkerIdx === -1) {
      logger.warn({ spreadsheetId }, 'No section markers found in Сводка sheet');
      return null;
    }

    const expenseCategories =
      expenseMarkerIdx !== -1 ? extractSectionCategories(cells, expenseMarkerIdx) : [];
    const incomeCategories =
      incomeMarkerIdx !== -1 ? extractSectionCategories(cells, incomeMarkerIdx) : [];

    logger.info(
      {
        spreadsheetId,
        expenseCount: expenseCategories.length,
        incomeCount: incomeCategories.length,
      },
      'Parsed categories from Сводка sheet',
    );

    return { expenseCategories, incomeCategories };
  } catch (error) {
    logger.error({ error, spreadsheetId }, 'Failed to parse Сводка sheet');
    return null;
  }
}

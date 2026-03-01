import type { sheets_v4 } from 'googleapis';
import type { Transaction } from './transactions.js';
import { logger } from '../logger.js';

const BRIEF_SHEET = 'Сводка';

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

function getMonthName(date: string): string {
  const month = parseInt(date.slice(5, 7), 10) - 1;
  return MONTH_NAMES[month]!;
}

function getWeekPeriod(day: number): string {
  if (day <= 8) return '1-8';
  if (day <= 16) return '9-16';
  if (day <= 24) return '17-24';
  return '25-31';
}

function columnIndexToLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

export async function updateBriefCell(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  transaction: Transaction,
  mode: 'add' | 'subtract',
): Promise<void> {
  const targetYear = transaction.date.slice(0, 4);
  const targetMonth = getMonthName(transaction.date);
  const targetWeek = getWeekPeriod(parseInt(transaction.date.slice(8, 10), 10));

  // Read column A to find the category row
  const colAResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${BRIEF_SHEET}!A:A`,
  });

  const colA: string[] = (colAResponse.data.values ?? []).map(
    (row) => (row[0] as string | undefined) ?? '',
  );

  const categoryRowIndex = colA.findIndex(
    (cell) => cell.trim().toLowerCase() === transaction.category.trim().toLowerCase(),
  );

  if (categoryRowIndex === -1) {
    logger.warn(
      { category: transaction.category, spreadsheetId },
      'Category not found in Сводка, skipping brief update',
    );
    return;
  }

  // Read rows 1, 2 and 3 to build the year+month+week column map
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${BRIEF_SHEET}!1:3`,
  });

  const headerRows = headerResponse.data.values ?? [];
  const yearRow: string[] = (headerRows[0] ?? []).map(
    (cell) => (cell as string | undefined) ?? '',
  );
  const monthRow: string[] = (headerRows[1] ?? []).map(
    (cell) => (cell as string | undefined) ?? '',
  );
  const weekRow: string[] = (headerRows[2] ?? []).map(
    (cell) => (cell as string | undefined) ?? '',
  );

  // Forward-fill empty year and month cells (merged cells only have value in first cell)
  let currentYear = '';
  let currentMonth = '';
  let targetColIndex = -1;

  for (let i = 0; i < weekRow.length; i++) {
    if (yearRow[i] && yearRow[i]!.trim()) {
      currentYear = yearRow[i]!.trim();
    }
    if (monthRow[i] && monthRow[i]!.trim()) {
      currentMonth = monthRow[i]!.trim();
    }
    const week = weekRow[i]?.trim() ?? '';
    if (currentYear === targetYear && currentMonth === targetMonth && week === targetWeek) {
      targetColIndex = i;
      break;
    }
  }

  if (targetColIndex === -1) {
    logger.warn(
      { targetYear, targetMonth, targetWeek, spreadsheetId },
      'Year/month/week column not found in Сводка, skipping brief update',
    );
    return;
  }

  const colLetter = columnIndexToLetter(targetColIndex);
  // categoryRowIndex is 0-based (array index), sheet rows are 1-based
  const cellAddress = `${BRIEF_SHEET}!${colLetter}${categoryRowIndex + 1}`;

  // Read current cell formula
  const cellResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: cellAddress,
    valueRenderOption: 'FORMULA',
  });

  const currentValue: string =
    ((cellResponse.data.values?.[0]?.[0] as string | undefined) ?? '').trim();

  let newFormula: string;

  if (!currentValue) {
    if (mode === 'subtract') {
      logger.warn({ cellAddress, spreadsheetId }, 'Cell is empty, nothing to subtract');
      return;
    }
    newFormula = `=${transaction.amount}`;
  } else {
    const operator = mode === 'add' ? '+' : '-';
    newFormula = `${currentValue}${operator}${transaction.amount}`;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: cellAddress,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newFormula]],
    },
  });

  logger.info(
    { cellAddress, newFormula, mode, category: transaction.category, spreadsheetId },
    'Сводка cell updated',
  );
}

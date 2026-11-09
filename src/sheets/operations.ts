import type { sheets_v4 } from 'googleapis';
import { rowMatches, type CellValue } from '../domain/operation.js';
import { logger } from '../logger.js';

export const OPERATIONS_SHEET = 'Операции';
const HEADER_ROWS = 1;

/**
 * 1-based number of the first empty row in column A below the header.
 * Reuses gaps left by undo; otherwise the row right after the data.
 */
export function findFreeRow(columnA: unknown[][]): number {
  for (let i = HEADER_ROWS; i < columnA.length; i++) {
    const cell = columnA[i]?.[0];
    if (cell === undefined || cell === null || String(cell).trim() === '') return i + 1;
  }
  return Math.max(columnA.length, HEADER_ROWS) + 1;
}

export type UndoStatus = 'cleared' | 'changed' | 'empty';

export interface UndoResult {
  status: UndoStatus;
  /** Row actually cleared — differs from the requested one after the owner sorted the sheet. */
  row: number;
}

export interface AppendResult {
  row: number;
  /** «Сумма USD» (column O) computed by the sheet, if available right away. */
  usd: number | null;
}

export interface WrittenRow {
  row: number;
  values: CellValue[];
}

export interface OperationsRepo {
  append(values: CellValue[]): Promise<AppendResult>;
  /** Writes rows as one block right after the last filled row (gaps are left for single saves). */
  appendMany(rows: CellValue[][]): Promise<WrittenRow[]>;
  /** Clears rows the bot wrote, each only if it still holds what was written; returns how many. */
  clearMany(rows: WrittenRow[]): Promise<number>;
  /** Clears A:L of a row the bot wrote, only if some row still holds `expected`. */
  undo(row: number, expected: CellValue[]): Promise<UndoResult>;
  /** «Операции»!A:L from row 1, header included, UNFORMATTED_VALUE. */
  readRows(): Promise<unknown[][]>;
}

function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

function isEmptyCell(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === false;
}

function isEmptyRow(row: unknown[] | undefined): boolean {
  return (row ?? []).every(isEmptyCell);
}

export type Located = { status: 'found'; row: number } | { status: 'changed' | 'empty' };

/**
 * Finds the 1-based row of «Операции» (`rows` = A:L from row 1) that still holds what the bot wrote.
 * The row number saved at write time is tried first; the owner may have sorted the sheet since,
 * so otherwise the only row with the same values wins. Several candidates — nothing is guessed.
 */
export function locateRow(rows: unknown[][], hintRow: number, expected: CellValue[]): Located {
  const hinted = rows[hintRow - 1];
  if (!isEmptyRow(hinted) && rowMatches(expected, hinted ?? []))
    return { status: 'found', row: hintRow };

  const matches: number[] = [];
  for (let i = HEADER_ROWS; i < rows.length; i++) {
    const row = rows[i];
    if (!isEmptyRow(row) && rowMatches(expected, row ?? [])) matches.push(i + 1);
  }
  if (matches.length === 1) return { status: 'found', row: matches[0]! };
  if (matches.length === 0 && isEmptyRow(hinted)) return { status: 'empty' };
  return { status: 'changed' };
}

interface Sheet {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
}

async function readRows({ sheets, spreadsheetId }: Sheet): Promise<unknown[][]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${OPERATIONS_SHEET}!A:L`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (response.data.values ?? []) as unknown[][];
}

/** Grows the sheet when a bulk write would run past its last row: `update` does not. */
async function ensureRows({ sheets, spreadsheetId }: Sheet, lastRow: number): Promise<void> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount)))',
  });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === OPERATIONS_SHEET)?.properties;
  const rowCount = sheet?.gridProperties?.rowCount ?? 0;
  if (sheet?.sheetId === undefined || sheet.sheetId === null || rowCount >= lastRow) return;
  const appendDimension = { sheetId: sheet.sheetId, dimension: 'ROWS', length: lastRow - rowCount };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ appendDimension }] },
  });
}

async function readUsd({ sheets, spreadsheetId }: Sheet, row: number): Promise<number | null> {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${OPERATIONS_SHEET}!O${row}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const value: unknown = response.data.values?.[0]?.[0];
    return typeof value === 'number' ? value : null;
  } catch (error) {
    logger.warn({ error, row }, 'Failed to read USD amount');
    return null;
  }
}

async function appendOne(sheet: Sheet, rowValues: CellValue[]): Promise<AppendResult> {
  const { sheets, spreadsheetId } = sheet;
  const column = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${OPERATIONS_SHEET}!A:A`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const row = findFreeRow((column.data.values ?? []) as unknown[][]);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${OPERATIONS_SHEET}!A${row}:L${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] },
  });
  logger.info({ row, values: rowValues }, 'Operation written');
  return { row, usd: await readUsd(sheet, row) };
}

async function undoOne(sheet: Sheet, row: number, expected: CellValue[]): Promise<UndoResult> {
  const located = locateRow(await readRows(sheet), row, expected);
  if (located.status !== 'found') return { status: located.status, row };
  const range = `${OPERATIONS_SHEET}!A${located.row}:L${located.row}`;
  await sheet.sheets.spreadsheets.values.clear({ spreadsheetId: sheet.spreadsheetId, range });
  logger.info({ row: located.row, savedRow: row }, 'Operation cleared');
  return { status: 'cleared', row: located.row };
}

async function appendBlock(sheet: Sheet, rows: CellValue[][]): Promise<WrittenRow[]> {
  if (rows.length === 0) return [];
  const start = (await readRows(sheet)).length + 1;
  const end = start + rows.length - 1;
  await ensureRows(sheet, end);
  await sheet.sheets.spreadsheets.values.update({
    spreadsheetId: sheet.spreadsheetId,
    range: `${OPERATIONS_SHEET}!A${start}:L${end}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  logger.info({ from: start, count: rows.length }, 'Operations written in bulk');
  return rows.map((values, i) => ({ row: start + i, values }));
}

async function clearBlock(sheet: Sheet, written: WrittenRow[]): Promise<number> {
  const rows = await readRows(sheet);
  const ranges = written.flatMap(({ row, values: expected }) => {
    const located = locateRow(rows, row, expected);
    return located.status === 'found'
      ? [`${OPERATIONS_SHEET}!A${located.row}:L${located.row}`]
      : [];
  });
  if (ranges.length > 0) {
    await sheet.sheets.spreadsheets.values.batchClear({
      spreadsheetId: sheet.spreadsheetId,
      requestBody: { ranges },
    });
  }
  logger.info({ requested: written.length, cleared: ranges.length }, 'Operations cleared in bulk');
  return ranges.length;
}

export function createOperationsRepo(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): OperationsRepo {
  const sheet: Sheet = { sheets, spreadsheetId };
  // Row lookup and write must not interleave, otherwise two saves could pick the same row
  const exclusive = createMutex();
  return {
    append: (values) => exclusive(() => appendOne(sheet, values)),
    undo: (row, expected) => exclusive(() => undoOne(sheet, row, expected)),
    appendMany: (rows) => exclusive(() => appendBlock(sheet, rows)),
    clearMany: (written) => exclusive(() => clearBlock(sheet, written)),
    readRows: () => readRows(sheet),
  };
}

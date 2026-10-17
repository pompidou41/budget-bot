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

export interface OperationsRepo {
  append(values: CellValue[]): Promise<AppendResult>;
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

export function createOperationsRepo(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): OperationsRepo {
  const values = sheets.spreadsheets.values;
  // Row lookup and write must not interleave, otherwise two saves could pick the same row
  const exclusive = createMutex();

  async function readRows(): Promise<unknown[][]> {
    const response = await values.get({
      spreadsheetId,
      range: `${OPERATIONS_SHEET}!A:L`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (response.data.values ?? []) as unknown[][];
  }

  async function readUsd(row: number): Promise<number | null> {
    try {
      const response = await values.get({
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

  return {
    append: (rowValues) =>
      exclusive(async () => {
        const column = await values.get({
          spreadsheetId,
          range: `${OPERATIONS_SHEET}!A:A`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        });
        const row = findFreeRow((column.data.values ?? []) as unknown[][]);

        await values.update({
          spreadsheetId,
          range: `${OPERATIONS_SHEET}!A${row}:L${row}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [rowValues] },
        });
        logger.info({ row, values: rowValues }, 'Operation written');

        return { row, usd: await readUsd(row) };
      }),

    undo: (row, expected) =>
      exclusive(async () => {
        const located = locateRow(await readRows(), row, expected);
        if (located.status !== 'found') return { status: located.status, row };

        const range = `${OPERATIONS_SHEET}!A${located.row}:L${located.row}`;
        await values.clear({ spreadsheetId, range });
        logger.info({ row: located.row, savedRow: row }, 'Operation cleared');
        return { status: 'cleared', row: located.row };
      }),

    readRows,
  };
}

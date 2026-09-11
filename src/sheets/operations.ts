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

export type UndoResult = 'cleared' | 'changed' | 'empty';

export interface AppendResult {
  row: number;
  /** «Сумма USD» (column N) computed by the sheet, if available right away. */
  usd: number | null;
}

export interface OperationsRepo {
  append(values: CellValue[]): Promise<AppendResult>;
  /** Clears A:K of a row the bot wrote, only if it still holds `expected`. */
  undo(row: number, expected: CellValue[]): Promise<UndoResult>;
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

export function createOperationsRepo(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): OperationsRepo {
  const values = sheets.spreadsheets.values;
  // Row lookup and write must not interleave, otherwise two saves could pick the same row
  const exclusive = createMutex();

  async function readUsd(row: number): Promise<number | null> {
    try {
      const response = await values.get({
        spreadsheetId,
        range: `${OPERATIONS_SHEET}!N${row}`,
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
          range: `${OPERATIONS_SHEET}!A${row}:K${row}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [rowValues] },
        });
        logger.info({ row, values: rowValues }, 'Operation written');

        return { row, usd: await readUsd(row) };
      }),

    undo: (row, expected) =>
      exclusive(async () => {
        const response = await values.get({
          spreadsheetId,
          range: `${OPERATIONS_SHEET}!A${row}:K${row}`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        });
        const actual = (response.data.values?.[0] ?? []) as unknown[];

        if (actual.every(isEmptyCell)) return 'empty';
        if (!rowMatches(expected, actual)) return 'changed';

        await values.clear({ spreadsheetId, range: `${OPERATIONS_SHEET}!A${row}:K${row}` });
        logger.info({ row }, 'Operation cleared');
        return 'cleared';
      }),
  };
}

import type { sheets_v4 } from 'googleapis';
import type { CellValue } from '../domain/operation.js';
import { logger } from '../logger.js';
import { HEADER_ROWS, isEmptyRow, locateRow, type WrittenRow } from './locate.js';
import { removeVerified, type RemoveResult } from './verified-delete.js';
import { refreshFilterRequests } from './operations-filter.js';

export const OPERATIONS_SHEET = 'Операции';
export { locateRow, type WrittenRow };
export type { RemoveResult };

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

export interface AppendResult {
  row: number;
  /** «Сумма USD» (column O) computed by the sheet, if available right away. */
  usd: number | null;
}

export interface OperationsRepo {
  append(values: CellValue[]): Promise<AppendResult>;
  /** Writes rows as one block right after the last filled row (gaps are left for single saves). */
  appendMany(rows: CellValue[][]): Promise<WrittenRow[]>;
  /**
   * Deletes rows the bot wrote, each only if exactly one row still holds its values, then checks
   * the sheet before/after and puts back any row removed by accident.
   */
  remove(rows: WrittenRow[]): Promise<RemoveResult>;
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

/**
 * 1-based row right after the last one holding data (`rows` = A:L from row 1). Checkbox columns
 * keep FALSE in thousands of empty rows below, so the API's row count says nothing.
 */
export function rowAfterData(rows: unknown[][]): number {
  for (let i = rows.length - 1; i >= HEADER_ROWS; i--) {
    if (!isEmptyRow(rows[i])) return i + 2;
  }
  return HEADER_ROWS + 1;
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

/**
 * Stretches the filter to the grid and re-applies its sort so new rows are sorted and filtered.
 * Best effort: the row is already written, so a failure is logged and never fails the save.
 */
async function refreshFilter({ sheets, spreadsheetId }: Sheet): Promise<void> {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        'sheets(properties(title,gridProperties(rowCount)),basicFilter(range,sortSpecs,filterSpecs))',
    });
    const sheet = meta.data.sheets?.find((s) => s.properties?.title === OPERATIONS_SHEET);
    const rowCount = sheet?.properties?.gridProperties?.rowCount ?? 0;
    const requests = refreshFilterRequests(sheet?.basicFilter, rowCount);
    if (requests.length === 0) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  } catch (error) {
    logger.warn({ error }, 'Failed to refresh the «Операции» filter');
  }
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
  // Read before the sort below moves the row
  const usd = await readUsd(sheet, row);
  await refreshFilter(sheet);
  return { row, usd };
}

async function appendBlock(sheet: Sheet, rows: CellValue[][]): Promise<WrittenRow[]> {
  if (rows.length === 0) return [];
  const start = rowAfterData(await readRows(sheet));
  const end = start + rows.length - 1;
  await ensureRows(sheet, end);
  await sheet.sheets.spreadsheets.values.update({
    spreadsheetId: sheet.spreadsheetId,
    range: `${OPERATIONS_SHEET}!A${start}:L${end}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  logger.info({ from: start, count: rows.length }, 'Operations written in bulk');
  await refreshFilter(sheet);
  return rows.map((values, i) => ({ row: start + i, values }));
}

/** Writes rows back into the given row numbers, growing the grid when they run past its end. */
async function writePlaces(
  sheet: Sheet,
  places: { row: number; cells: unknown[] }[],
): Promise<void> {
  await ensureRows(sheet, Math.max(...places.map((p) => p.row)));
  await sheet.sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheet.spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: places.map(({ row, cells }) => ({
        range: `${OPERATIONS_SHEET}!A${row}:L${row}`,
        values: [cells],
      })),
    },
  });
}

async function removeRows(sheet: Sheet, targets: WrittenRow[]): Promise<RemoveResult> {
  const result = await removeVerified(
    {
      read: () => readRows(sheet),
      clear: async (rows) => {
        const ranges = rows.map((r) => `${OPERATIONS_SHEET}!A${r}:L${r}`);
        await sheet.sheets.spreadsheets.values.batchClear({
          spreadsheetId: sheet.spreadsheetId,
          requestBody: { ranges },
        });
      },
      write: (places) => writePlaces(sheet, places),
    },
    targets,
  );
  logger.info(
    {
      requested: targets.length,
      removed: result.removed.map((r) => r.row),
      stillPresent: result.stillPresent.length,
      collateral: result.collateral,
    },
    'Operations removed',
  );
  if (result.collateral.length > 0) await refreshFilter(sheet);
  return result;
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
    appendMany: (rows) => exclusive(() => appendBlock(sheet, rows)),
    remove: (targets) => exclusive(() => removeRows(sheet, targets)),
    readRows: () => readRows(sheet),
  };
}

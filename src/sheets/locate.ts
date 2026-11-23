import { rowMatches, type CellValue } from '../domain/operation.js';

export const HEADER_ROWS = 1;

/** A row the bot wrote: where it was put and exactly what. */
export interface WrittenRow {
  row: number;
  values: CellValue[];
}

function isEmptyCell(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === false;
}

export function isEmptyRow(row: unknown[] | undefined): boolean {
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

export interface LiveRow {
  target: WrittenRow;
  /** Where the row sits now (it moves when the owner sorts the sheet). */
  row: number;
  /** The cells as they are in the sheet right now. */
  cells: unknown[];
}

/** Finds each target in `rows` by values; the second list holds those not found exactly once. */
export function locateTargets(
  rows: unknown[][],
  targets: WrittenRow[],
): { found: LiveRow[]; notFound: WrittenRow[] } {
  const found: LiveRow[] = [];
  const notFound: WrittenRow[] = [];
  for (const target of targets) {
    const at = locateRow(rows, target.row, target.values);
    // Two targets must never claim one row
    if (at.status === 'found' && !found.some((f) => f.row === at.row)) {
      found.push({ target, row: at.row, cells: rows[at.row - 1] ?? [] });
    } else notFound.push(target);
  }
  return { found, notFound };
}

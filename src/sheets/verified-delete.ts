import { asText, rowKey, type CellValue } from '../domain/operation.js';
import { diffRemoval } from '../domain/removal.js';
import { HEADER_ROWS, isEmptyRow, locateTargets, type WrittenRow } from './locate.js';

/** A row that vanished although it was not meant to, and whether it was put back. */
export interface Collateral {
  cells: unknown[];
  /** Row it was written back to; null when restoring failed. */
  restoredTo: number | null;
}

export interface RemoveResult {
  /** Rows verified gone, with the row they sat in. */
  removed: WrittenRow[];
  /** Not found exactly once by their values before clearing: left untouched. */
  notFound: WrittenRow[];
  /** Rows we meant to clear that are still there afterwards. */
  stillPresent: WrittenRow[];
  collateral: Collateral[];
}

/** The sheet operations the verified delete needs; operations.ts wires them to the API. */
export interface DeleteIo {
  read(): Promise<unknown[][]>;
  clear(rows: number[]): Promise<void>;
  write(places: { row: number; cells: unknown[] }[]): Promise<void>;
}

/** Empty rows to put `count` rows back into: gaps first, then below the data. */
export function emptyRowsFor(rows: unknown[][], count: number): number[] {
  const places: number[] = [];
  for (let i = HEADER_ROWS; i < rows.length && places.length < count; i++) {
    if (isEmptyRow(rows[i])) places.push(i + 1);
  }
  let next = rows.length + 1;
  while (places.length < count) places.push(next++);
  return places;
}

function writable(cells: unknown[]): CellValue[] {
  return Array.from({ length: 12 }, (_, i) => {
    const value = cells[i];
    if (typeof value === 'string') return asText(value);
    return typeof value === 'number' || typeof value === 'boolean' ? value : '';
  });
}

async function putBack(io: DeleteIo, lost: unknown[][], after: unknown[][]): Promise<Collateral[]> {
  const rows = emptyRowsFor(after, lost.length);
  try {
    await io.write(lost.map((cells, i) => ({ row: rows[i]!, cells: writable(cells) })));
    return lost.map((cells, i) => ({ cells, restoredTo: rows[i]! }));
  } catch {
    return lost.map((cells) => ({ cells, restoredTo: null }));
  }
}

/**
 * Clears the rows holding `targets`, then reads the sheet again and checks that exactly those
 * rows vanished. A row that vanished by accident (the owner re-sorted between our read and the
 * clear) is written back. Call inside the sheet's mutex.
 */
export async function removeVerified(io: DeleteIo, targets: WrittenRow[]): Promise<RemoveResult> {
  const before = await io.read();
  const { found, notFound } = locateTargets(before, targets);
  if (found.length === 0) return { removed: [], notFound, stillPresent: [], collateral: [] };

  await io.clear(found.map((f) => f.row));
  const after = await io.read();
  const diff = diffRemoval(
    before.slice(HEADER_ROWS),
    after.slice(HEADER_ROWS),
    found.map((f) => f.cells),
  );
  const survivors = new Set(diff.stillPresent.map(rowKey));
  const isLeft = (f: { cells: unknown[] }) => survivors.has(rowKey(f.cells));
  const asWritten = (f: { row: number; target: WrittenRow }): WrittenRow => ({
    row: f.row,
    values: f.target.values,
  });
  // A wrong row was cleared only if a target survived (a re-sort raced us). Without that, a row
  // that "vanished" was edited by hand meanwhile, and writing its old version back would duplicate it.
  const raced = diff.stillPresent.length > 0 && diff.extra.length > 0;
  return {
    removed: found.filter((f) => !isLeft(f)).map(asWritten),
    notFound,
    stillPresent: found.filter(isLeft).map(asWritten),
    collateral: raced ? await putBack(io, diff.extra, after) : [],
  };
}

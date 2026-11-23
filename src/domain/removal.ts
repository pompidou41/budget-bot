import { rowKey } from './operation.js';

export interface RemovalDiff {
  /** Rows that vanished although nobody asked for it (the sheet was re-sorted under us). */
  extra: unknown[][];
  /** Expected rows that are still in the sheet. */
  stillPresent: unknown[][];
}

function isBlank(key: string): boolean {
  return key.split('\u0001').every((part) => part === '');
}

function count(rows: unknown[][]): Map<string, { n: number; cells: unknown[] }> {
  const map = new Map<string, { n: number; cells: unknown[] }>();
  for (const cells of rows) {
    const key = rowKey(cells);
    if (isBlank(key)) continue;
    const entry = map.get(key);
    if (entry) entry.n++;
    else map.set(key, { n: 1, cells });
  }
  return map;
}

/**
 * Compares «Операции» before and after a clear as multisets of normalized rows (header skipped
 * by the caller). `expected` are the rows meant to disappear. Rows that appeared meanwhile are
 * ignored: only what vanished matters.
 */
export function diffRemoval(
  before: unknown[][],
  after: unknown[][],
  expected: unknown[][],
): RemovalDiff {
  const was = count(before);
  const now = count(after);
  const meant = count(expected);
  const extra: unknown[][] = [];
  const stillPresent: unknown[][] = [];

  for (const [key, { n, cells }] of was) {
    const removed = Math.max(0, n - (now.get(key)?.n ?? 0));
    const wanted = meant.get(key)?.n ?? 0;
    for (let i = wanted; i < removed; i++) extra.push(cells);
    for (let i = removed; i < wanted; i++) stillPresent.push(cells);
  }
  return { extra, stillPresent };
}

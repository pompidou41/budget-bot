/** A range wider than this is a typo (a year, an amount), not a pick of statement rows. */
const MAX_RANGE = 50;

/**
 * Statement row numbers in a reply to the import list: «4 6 12», «#4, #6», «4-8», «4–8».
 * Unique and ascending; empty when the text names no rows.
 */
export function parseRowNumbers(text: string): number[] {
  const rows = new Set<number>();
  for (const match of text.matchAll(/(\d+)(?:\s*[-–—]\s*(\d+))?/g)) {
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (to < from || to - from > MAX_RANGE) continue;
    for (let row = from; row <= to; row++) rows.add(row);
  }
  return [...rows].sort((a, b) => a - b);
}

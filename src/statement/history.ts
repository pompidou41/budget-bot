import type { Txn } from '../analytics/dataset.js';

const DEFAULT_LIMIT = 150;

/**
 * How the owner booked operations on this account before, newest first, one line per distinct
 * comment: «Agrohub → Расход · Food / Groceries». The model copies the owner's own choices.
 */
export function bookingHistory(txns: Txn[], account: string, limit = DEFAULT_LIMIT): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (let i = txns.length - 1; i >= 0 && lines.length < limit; i--) {
    const txn = txns[i]!;
    if (txn.account !== account && txn.toAccount !== account) continue;
    const key = txn.comment.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const category = txn.subcategory ? `${txn.category} / ${txn.subcategory}` : txn.category;
    const route = txn.type === 'Перевод' ? ` (${txn.account} → ${txn.toAccount})` : '';
    lines.push(
      `${txn.comment.replace(/\s+/g, ' ').slice(0, 60)} → ${txn.type}${route} · ${category}`,
    );
  }
  return lines;
}

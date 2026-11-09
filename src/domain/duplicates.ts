import { isIsoDate, serialToIso } from './dates.js';
import { escapeHtml, formatAmount } from './format.js';
import { OP_TYPES, type Operation, type OpType } from './operation.js';
import { findAccount, type Reference } from './reference.js';

/** Bank posting lags the purchase by a day; a same-account repeat further apart is a new purchase. */
const SAME_SIDE_DAYS = 1;
/** Money between two banks may take a few days to land. */
const CROSS_SIDE_DAYS = 3;
/** Exchange fees make the two sides of a transfer differ slightly (170,38 sent → 170,00 landed). */
const RECEIVED_TOLERANCE = 0.01;

/** Fields that identify a money movement; a sheet row or a draft both provide them. */
export type Movement = Pick<
  Operation,
  'date' | 'type' | 'account' | 'amount' | 'toAccount' | 'received' | 'comment'
>;

export type Source = { kind: 'row'; row: number } | { kind: 'draft'; draftId: string };

export interface Existing {
  op: Movement;
  source: Source;
}

export interface Duplicate {
  /** `exact` is not written without the owner's say; `possible` is only flagged. */
  kind: 'exact' | 'possible';
  match: Existing;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isOpType(value: string): value is OpType {
  return (OP_TYPES as readonly string[]).includes(value);
}

/** «Операции»!A:L read with UNFORMATTED_VALUE (header included) → movements with their rows. */
export function sheetMovements(rows: unknown[][]): Existing[] {
  const result: Existing[] = [];
  rows.forEach((row, index) => {
    if (index === 0) return;
    const serial = positive(row[0]);
    const date = serial === null ? text(row[0]) : serialToIso(serial);
    const type = text(row[1]);
    const amount = positive(row[3]);
    if (!isIsoDate(date) || !isOpType(type) || amount === null) return;
    result.push({
      op: {
        date,
        type,
        account: text(row[2]) || null,
        amount,
        toAccount: text(row[4]) || null,
        received: positive(row[5]),
        comment: text(row[8]),
      },
      source: { kind: 'row', row: index + 1 },
    });
  });
  return result;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

function sameMoney(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) < 0.005;
}

function closeMoney(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= Math.max(a, b) * RECEIVED_TOLERANCE + 0.005;
}

/** What landed on the receiving account; a same-currency transfer leaves «Получено» empty. */
function landed(op: Movement): number | null {
  return op.received ?? op.amount;
}

/**
 * One side of a transfer in two records. `loose`: same account, the amount is missing in one of
 * them — a statement knows only its own currency, so 1 140,84 GEL landed from rubles it never saw.
 */
type Side = 'equal' | 'close' | 'loose' | 'unknown' | 'different';

function compareSide(
  accounts: [string | null, string | null],
  amounts: [number | null, number | null],
  tolerant: boolean,
): Side {
  const [accountA, accountB] = accounts;
  const [amountA, amountB] = amounts;
  if (accountA === null || accountB === null) return 'unknown';
  if (accountA !== accountB) return 'different';
  if (amountA === null || amountB === null) return 'loose';
  if (sameMoney(amountA, amountB)) return 'equal';
  return tolerant && closeMoney(amountA, amountB) ? 'close' : 'different';
}

function compareTransfers(a: Movement, b: Movement, days: number): Duplicate['kind'] | null {
  const from = compareSide([a.account, b.account], [a.amount, b.amount], false);
  const to = compareSide([a.toAccount, b.toAccount], [a.received, b.received], true);
  if (from === 'different' || to === 'different' || days > CROSS_SIDE_DAYS) return null;

  const sides = [from, to];
  if (sides.includes('unknown')) {
    // Only one bank's half is known: its amount has to agree
    return sides.some((side) => side === 'equal' || side === 'close') ? 'possible' : null;
  }
  const exact =
    days === 0 && sides.includes('equal') && sides.every((s) => s === 'equal' || s === 'loose');
  return exact ? 'exact' : 'possible';
}

/** A plain expense or income against one side of a transfer — the other bank's view of it. */
function againstTransfer(single: Movement, transfer: Movement, days: number): boolean {
  if (days > CROSS_SIDE_DAYS || single.account === null) return false;
  if (single.type === 'Расход') {
    return single.account === transfer.account && sameMoney(single.amount, transfer.amount);
  }
  return single.account === transfer.toAccount && closeMoney(single.amount, landed(transfer));
}

/** How `incoming` relates to `existing`, or null when they are different operations. */
export function compareMovements(incoming: Movement, existing: Movement): Duplicate['kind'] | null {
  const days = daysApart(incoming.date, existing.date);
  if (incoming.type === 'Перевод' && existing.type === 'Перевод') {
    return compareTransfers(incoming, existing, days);
  }
  if (incoming.type === 'Перевод') {
    return existing.type !== 'Перевод' && againstTransfer(existing, incoming, days)
      ? 'possible'
      : null;
  }
  if (existing.type === 'Перевод') {
    return againstTransfer(incoming, existing, days) ? 'possible' : null;
  }
  if (incoming.type !== existing.type || incoming.account === null) return null;
  if (incoming.account !== existing.account || !sameMoney(incoming.amount, existing.amount)) {
    return null;
  }
  if (days === 0) return 'exact';
  return days <= SAME_SIDE_DAYS ? 'possible' : null;
}

function sourceKey(source: Source): string {
  return source.kind === 'row' ? `r${source.row}` : `d${source.draftId}`;
}

/**
 * Pairs each incoming operation with at most one existing one, and each existing one with at
 * most one incoming: two 1-lari metro rides against one recorded ride leave the second one new.
 * Exact pairs are settled first, then the closest possible ones.
 */
export function findDuplicates(incoming: Movement[], existing: Existing[]): (Duplicate | null)[] {
  const result: (Duplicate | null)[] = incoming.map(() => null);
  const used = new Set<string>();

  for (const wanted of ['exact', 'possible'] as const) {
    incoming.forEach((op, i) => {
      if (result[i]) return;
      let best: Existing | undefined;
      for (const candidate of existing) {
        if (used.has(sourceKey(candidate.source))) continue;
        if (compareMovements(op, candidate.op) !== wanted) continue;
        if (!best || daysApart(op.date, candidate.op.date) < daysApart(op.date, best.op.date)) {
          best = candidate;
        }
      }
      if (best) {
        used.add(sourceKey(best.source));
        result[i] = { kind: wanted, match: best };
      }
    });
  }
  return result;
}

function moneyOf(ref: Reference, accountId: string | null, amount: number | null): string {
  if (amount === null) return '?';
  const currency = (accountId && findAccount(ref, accountId)?.currency) || '';
  return currency ? `${formatAmount(amount)} ${currency}` : formatAmount(amount);
}

/** «09.10 · CREDO_USD · 10 USD · Localrent» — HTML, escaped. */
export function summarize(op: Movement, ref: Reference): string {
  const [, month, day] = op.date.split('-');
  const accounts =
    op.type === 'Перевод' ? `${op.account ?? '?'} → ${op.toAccount ?? '?'}` : (op.account ?? '?');
  const parts = [
    `${day}.${month}`,
    accounts,
    moneyOf(ref, op.account, op.amount),
    op.comment.slice(0, 40),
  ].filter(Boolean);
  return escapeHtml(parts.join(' · '));
}

/** «строка 734: 09.10 · CREDO_USD · 10 USD · Localrent» — HTML, escaped. */
export function describeMatch(match: Existing, ref: Reference): string {
  const where = match.source.kind === 'row' ? `строка ${match.source.row}` : 'черновик выше';
  return `${where}: ${summarize(match.op, ref)}`;
}

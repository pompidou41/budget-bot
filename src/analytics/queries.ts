import { activeAccounts, type Reference } from '../domain/reference.js';
import type { Txn } from './dataset.js';

const MONTH_NAMES = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

/** Groups whose balance is money available for this month's spending. */
export const SPENDABLE_GROUPS = ['Текущие', 'Ежемесячные'];

export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number);
  const total = (year ?? 0) * 12 + (index ?? 1) - 1 + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** `count` months ending with the month of `today`, oldest first. */
export function recentMonths(today: string, count: number): string[] {
  const current = today.slice(0, 7);
  return Array.from({ length: count }, (_, i) => shiftMonth(current, i - count + 1));
}

export function daysInMonth(month: string): number {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, index ?? 1, 0)).getUTCDate();
}

export function monthLabel(month: string): string {
  const [year, index] = month.split('-');
  return `${MONTH_NAMES[Number(index) - 1] ?? month} ${year?.slice(2) ?? ''}`;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function sumUsd(txns: Txn[]): number {
  return txns.reduce((total, txn) => total + txn.usd, 0);
}

/** Regular spending: excludes transfers between own accounts and one-off purchases. */
export function isRegularExpense(txn: Txn): boolean {
  return txn.type === 'Расход' && !txn.oneOff;
}

export interface MatrixRow {
  category: string;
  subcategory: string;
  byMonth: Map<string, number>;
  total: number;
}

/** Category-by-month totals in USD, heaviest rows first. */
export function buildMatrix(
  txns: Txn[],
  months: string[],
  include: (txn: Txn) => boolean,
): MatrixRow[] {
  const window = new Set(months);
  const rows = new Map<string, MatrixRow>();

  for (const txn of txns) {
    if (!window.has(txn.month) || !include(txn)) continue;
    const key = `${txn.category} ${txn.subcategory}`;
    const row = rows.get(key) ?? {
      category: txn.category || 'Без категории',
      subcategory: txn.subcategory,
      byMonth: new Map<string, number>(),
      total: 0,
    };
    row.byMonth.set(txn.month, (row.byMonth.get(txn.month) ?? 0) + txn.usd);
    row.total += txn.usd;
    rows.set(key, row);
  }

  return [...rows.values()].sort((a, b) => b.total - a.total);
}

/** Per-month totals of whatever `include` accepts, with zeros for empty months. */
export function monthlyTotals(
  txns: Txn[],
  months: string[],
  include: (txn: Txn) => boolean,
): Map<string, number> {
  const totals = new Map(months.map((month) => [month, 0]));
  for (const txn of txns) {
    if (!totals.has(txn.month) || !include(txn)) continue;
    totals.set(txn.month, (totals.get(txn.month) ?? 0) + txn.usd);
  }
  return totals;
}

export interface RegularEstimate {
  category: string;
  median: number;
  max: number;
  /** How many of the analysed months had any spending in this category. */
  monthsSeen: number;
}

/**
 * What a typical month costs per category: the median over full months, so one outlier
 * month does not move it. One-off purchases are excluded by definition.
 */
export function regularMonthly(
  txns: Txn[],
  months: string[],
): { rows: RegularEstimate[]; total: number } {
  const byCategory = new Map<string, Map<string, number>>();

  for (const row of buildMatrix(txns, months, isRegularExpense)) {
    const totals = byCategory.get(row.category) ?? new Map<string, number>();
    for (const [month, value] of row.byMonth) {
      totals.set(month, (totals.get(month) ?? 0) + value);
    }
    byCategory.set(row.category, totals);
  }

  const rows: RegularEstimate[] = [];
  for (const [category, totals] of byCategory) {
    // Months without spending count as zeros, otherwise a rare category looks monthly
    const values = months.map((month) => totals.get(month) ?? 0);
    rows.push({
      category,
      median: median(values),
      max: Math.max(...values),
      monthsSeen: values.filter((value) => value > 0).length,
    });
  }

  rows.sort((a, b) => b.median - a.median);
  return { rows, total: rows.reduce((sum, row) => sum + row.median, 0) };
}

export interface MonthBudget {
  month: string;
  daysPassed: number;
  daysTotal: number;
  daysLeft: number;
  /** Regular expenses already made this month, USD. */
  spent: number;
  spentOneOff: number;
  /** Median regular spending of the preceding full months. */
  typical: number;
  /** What is still expected to be spent before the month ends. */
  projectedRest: number;
  /** Balance of the spendable account groups, USD. */
  available: number;
  /** `available` minus `projectedRest`: what survives a usual rest of the month. */
  free: number;
}

export function monthBudget(
  txns: Txn[],
  ref: Reference,
  today: string,
  historyMonths = 6,
): MonthBudget {
  const month = today.slice(0, 7);
  const past = Array.from({ length: historyMonths }, (_, i) =>
    shiftMonth(month, i - historyMonths),
  );

  const typical = median([...monthlyTotals(txns, past, isRegularExpense).values()]);
  const spent = sumUsd(txns.filter((t) => t.month === month && isRegularExpense(t)));
  const spentOneOff = sumUsd(
    txns.filter((t) => t.month === month && t.type === 'Расход' && t.oneOff),
  );
  const available = activeAccounts(ref)
    .filter((a) => SPENDABLE_GROUPS.includes(a.group))
    .reduce((sum, a) => sum + (a.balanceUsd ?? 0), 0);

  const daysTotal = daysInMonth(month);
  const daysPassed = Number(today.slice(8, 10));
  const projectedRest = Math.max(typical - spent, 0);

  return {
    month,
    daysPassed,
    daysTotal,
    daysLeft: daysTotal - daysPassed,
    spent,
    spentOneOff,
    typical,
    projectedRest,
    available,
    free: available - projectedRest,
  };
}

export interface TxnQuery {
  from: string;
  to: string;
  type: string;
  category: string;
  subcategory: string;
  account: string;
  search: string;
  minUsd: number;
  limit: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function matches(value: string, filter: string): boolean {
  return !filter || value.toLowerCase() === filter.toLowerCase();
}

/** Raw rows for drill-down questions ("покажи сами траты на рестораны в августе"). */
export function findTxns(txns: Txn[], query: Partial<TxnQuery>): Txn[] {
  const search = query.search?.trim().toLowerCase() ?? '';
  const minUsd = query.minUsd ?? 0;

  const found = txns.filter((txn) => {
    if (query.from && txn.date < query.from) return false;
    if (query.to && txn.date > query.to) return false;
    if (!matches(txn.type, query.type ?? '')) return false;
    if (!matches(txn.category, query.category ?? '')) return false;
    if (!matches(txn.subcategory, query.subcategory ?? '')) return false;
    if (query.account && txn.account !== query.account && txn.toAccount !== query.account) {
      return false;
    }
    if (txn.usd < minUsd) return false;
    if (search && !txn.comment.toLowerCase().includes(search)) return false;
    return true;
  });

  found.sort((a, b) => b.date.localeCompare(a.date));
  return found.slice(0, Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT));
}

import { addDays } from '../domain/dates.js';
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

/** The two slices history is cut into: calendar months, or ISO weeks (Monday–Sunday). */
export type Period = 'week' | 'month';

const MS_PER_DAY = 86_400_000;

function utcDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year ?? NaN, (month ?? 1) - 1, day ?? 1));
}

/** Monday of the ISO week containing `iso`. */
export function weekStart(iso: string): string {
  // getUTCDay is Sunday-based; ISO weeks start on Monday
  const offset = (utcDate(iso).getUTCDay() + 6) % 7;
  return addDays(iso, -offset);
}

/**
 * ISO-8601 week key, e.g. `2026-W37`. The year is the *ISO* year, which is why the week is
 * numbered from the Thursday of its own week: 2027-01-01 belongs to week 53 of 2026.
 */
export function weekKey(iso: string): string {
  const thursday = utcDate(addDays(weekStart(iso), 3));
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = utcDate(addDays(weekStart(`${isoYear}-01-04`), 3));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** First day of a week key, inverting {@link weekKey}. */
export function weekKeyStart(key: string): string {
  const [year, week] = key.split('-W').map(Number);
  const firstMonday = weekStart(`${year ?? 0}-01-04`);
  return addDays(firstMonday, ((week ?? 1) - 1) * 7);
}

export function periodKey(iso: string, period: Period): string {
  return period === 'week' ? weekKey(iso) : iso.slice(0, 7);
}

/** Column header for a period: `сен 26` or `07–13.09`, readable without a legend. */
export function periodLabel(key: string, period: Period): string {
  if (period === 'month') return monthLabel(key);
  const from = weekKeyStart(key);
  const to = addDays(from, 6);
  // A week straddling two months needs both, or `31–06.09` reads as a 24-day span
  const start =
    from.slice(5, 7) === to.slice(5, 7) ? from.slice(8) : `${from.slice(8)}.${from.slice(5, 7)}`;
  return `${start}–${to.slice(8)}.${to.slice(5, 7)}`;
}

/**
 * Keeps only the periods the sheet actually has records for. A period before the first record
 * is not a period of zero spending — there is no data for it. Counting such periods as zeros
 * drags every «usual» estimate towards nothing for anyone with a short history.
 */
export function recordedPeriods(keys: string[], txns: Txn[], period: Period): string[] {
  let first: string | undefined;
  for (const txn of txns) {
    if (txn.date && (first === undefined || txn.date < first)) first = txn.date;
  }
  if (first === undefined) return [];

  const startKey = periodKey(first, period);
  // The period where history begins counts when most of it is on record. Demanding a record on
  // its very first day would throw away a whole month of a short history — real sheets rarely
  // start on the 1st — while a history opening on a Friday or the 20th would pass for an
  // unusually cheap period.
  const mostlyRecorded =
    period === 'week'
      ? (utcDate(first).getUTCDay() + 6) % 7 <= 3
      : Number(first.slice(8, 10)) <= 15;
  // Week keys are zero-padded, so they order correctly as strings, across years too
  return keys.filter((key) => key > startKey || (key === startKey && mostlyRecorded));
}

/** `count` periods ending with the one containing `today`, oldest first. */
export function recentPeriods(today: string, period: Period, count: number): string[] {
  if (period === 'month') return recentMonths(today, count);
  const monday = weekStart(today);
  return Array.from({ length: count }, (_, i) => weekKey(addDays(monday, (i - count + 1) * 7)));
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
  byPeriod: Map<string, number>;
  total: number;
}

/** The month comes from the sheet's own column T; weeks are derived from the date. */
function keyOf(txn: Txn, period: Period): string {
  return period === 'week' ? weekKey(txn.date) : txn.month;
}

/** Category-by-period totals in USD, heaviest rows first. */
export function buildMatrix(
  txns: Txn[],
  periods: string[],
  include: (txn: Txn) => boolean,
  period: Period = 'month',
): MatrixRow[] {
  const window = new Set(periods);
  const rows = new Map<string, MatrixRow>();

  for (const txn of txns) {
    const key = keyOf(txn, period);
    if (!window.has(key) || !include(txn)) continue;
    const rowKey = `${txn.category} ${txn.subcategory}`;
    const row = rows.get(rowKey) ?? {
      category: txn.category || 'Без категории',
      subcategory: txn.subcategory,
      byPeriod: new Map<string, number>(),
      total: 0,
    };
    row.byPeriod.set(key, (row.byPeriod.get(key) ?? 0) + txn.usd);
    row.total += txn.usd;
    rows.set(rowKey, row);
  }

  return [...rows.values()].sort((a, b) => b.total - a.total);
}

/** Category totals over the whole window, merging subcategories; heaviest first. */
export function byCategory(rows: MatrixRow[]): MatrixRow[] {
  const merged = new Map<string, MatrixRow>();
  for (const row of rows) {
    const target = merged.get(row.category) ?? {
      category: row.category,
      subcategory: '',
      byPeriod: new Map<string, number>(),
      total: 0,
    };
    for (const [key, value] of row.byPeriod) {
      target.byPeriod.set(key, (target.byPeriod.get(key) ?? 0) + value);
    }
    target.total += row.total;
    merged.set(row.category, target);
  }
  return [...merged.values()].sort((a, b) => b.total - a.total);
}

/** Per-period totals of whatever `include` accepts, with zeros for empty periods. */
export function periodTotals(
  txns: Txn[],
  periods: string[],
  include: (txn: Txn) => boolean,
  period: Period = 'month',
): Map<string, number> {
  const totals = new Map(periods.map((key) => [key, 0]));
  for (const txn of txns) {
    const key = keyOf(txn, period);
    if (!totals.has(key) || !include(txn)) continue;
    totals.set(key, (totals.get(key) ?? 0) + txn.usd);
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
  const totalsByCategory = new Map<string, Map<string, number>>();

  for (const row of buildMatrix(txns, months, isRegularExpense)) {
    const totals = totalsByCategory.get(row.category) ?? new Map<string, number>();
    for (const [month, value] of row.byPeriod) {
      totals.set(month, (totals.get(month) ?? 0) + value);
    }
    totalsByCategory.set(row.category, totals);
  }

  const rows: RegularEstimate[] = [];
  for (const [category, totals] of totalsByCategory) {
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
  /** How many recorded months `typical` rests on; fewer than asked for on a short history. */
  typicalMonths: number;
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
  const past = recordedPeriods(
    Array.from({ length: historyMonths }, (_, i) => shiftMonth(month, i - historyMonths)),
    txns,
    'month',
  );

  const typical = median([...periodTotals(txns, past, isRegularExpense).values()]);
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
    typicalMonths: past.length,
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

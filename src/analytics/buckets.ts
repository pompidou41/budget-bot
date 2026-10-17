import { categoryLabel } from '../domain/category-labels.js';
import { escapeHtml, formatMoney, type MoneyCurrency } from '../domain/format.js';
import type { Txn } from './dataset.js';
import {
  BUCKETS_PER_MONTH,
  bucketEnd,
  bucketKey,
  bucketTitle,
  buildMatrix,
  byCategory,
  median,
  periodTotals,
  recordedPeriods,
  shiftBucket,
  type Money,
} from './queries.js';

/** How many earlier months the «usual» value of a bucket is taken from. */
const BASELINE_MONTHS = 6;
/** One earlier month is an anecdote, not «usual»; two at least give a middle. */
const MIN_BASELINE = 2;
/** A category is worth a line when it moved by this much of its own usual level… */
const MIN_SHIFT_OF_USUAL = 0.15;
/** …and by this much of the whole bucket, so a small category's big swing is not news. */
const MIN_SHIFT_OF_TOTAL = 0.05;
const MAX_ABOVE = 2;
const MAX_BELOW = 1;
const CAPTION_LIMIT = 1024;

const MONTHS_NOMINATIVE = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

export interface RecapOptions {
  money: Money;
  /** One-off purchases count only when asked for, the way `/report` treats them. */
  oneOff: boolean;
}

export interface CategoryShift {
  category: string;
  /** What the category spent in the bucket. */
  actual: number;
  /** Median of the same bucket in earlier months, zeros included. */
  usual: number;
  delta: number;
}

export interface MonthToDate {
  month: string;
  spent: number;
  /** Median of the earlier months' running total over the same buckets. */
  usual: number;
  deltaPct: number | null;
  /** Last day the running total reaches: the end of the closed bucket. */
  throughDay: number;
  /** The month is over: the fourth bucket closes it. */
  complete: boolean;
}

export interface BucketSummary {
  key: string;
  money: Money;
  total: number;
  /** null when fewer than {@link MIN_BASELINE} earlier months have records to compare against. */
  usual: number | null;
  deltaPct: number | null;
  /** How many earlier months «usual» rests on. */
  baselineMonths: number;
  /** Biggest overspends against usual, heaviest first. */
  above: CategoryShift[];
  /** Biggest savings against usual, biggest first. */
  below: CategoryShift[];
  /** null for the first bucket of a month (it would repeat the headline) or without a baseline. */
  monthToDate: MonthToDate | null;
}

/** The newest bucket that has already ended on `today`. */
export function lastClosedBucket(today: string): string {
  return shiftBucket(bucketKey(today), -1);
}

function percent(actual: number, usual: number): number | null {
  return usual > 0 ? ((actual - usual) / usual) * 100 : null;
}

/**
 * How a closed bucket went against «usual»: the same bucket (1–8, 9–16, …) in the previous six
 * months, not the previous six buckets — rent on the 1st and salary on the 9th make the slots of
 * a month differ from each other far more than the same slot differs from month to month.
 */
export function summarizeBucket(txns: Txn[], key: string, options: RecapOptions): BucketSummary {
  const { money, oneOff } = options;
  const include = (txn: Txn): boolean => txn.type === 'Расход' && (oneOff || !txn.oneOff);

  const slot = Number(key.slice(-1));
  const candidates = Array.from({ length: BASELINE_MONTHS }, (_, i) =>
    shiftBucket(key, (i - BASELINE_MONTHS) * BUCKETS_PER_MONTH),
  );
  // Months before the first record are not months of zero spending — there is no data for them
  const baseline = recordedPeriods(candidates, txns, 'bucket');
  const enough = baseline.length >= MIN_BASELINE;

  const totals = periodTotals(txns, [key, ...baseline], include, 'bucket', money);
  const total = totals.get(key) ?? 0;
  const usual = enough ? median(baseline.map((k) => totals.get(k) ?? 0)) : null;

  const current = byCategory(buildMatrix(txns, [key], include, 'bucket', money));
  const history = byCategory(buildMatrix(txns, baseline, include, 'bucket', money));
  const currentBy = new Map(current.map((row) => [row.category, row.total]));
  const historyBy = new Map(history.map((row) => [row.category, row]));

  const shifts: CategoryShift[] = [];
  if (enough && usual !== null) {
    // An empty bucket has no total to take a share of; its usual level is what is missing
    const base = total > 0 ? total : usual;
    for (const category of new Set([...currentBy.keys(), ...historyBy.keys()])) {
      const row = historyBy.get(category);
      const categoryUsual = median(baseline.map((k) => row?.byPeriod.get(k) ?? 0));
      const actual = currentBy.get(category) ?? 0;
      const delta = actual - categoryUsual;
      const big =
        Math.abs(delta) >= MIN_SHIFT_OF_USUAL * categoryUsual &&
        Math.abs(delta) >= MIN_SHIFT_OF_TOTAL * base;
      if (big && delta !== 0) shifts.push({ category, actual, usual: categoryUsual, delta });
    }
  }

  return {
    key,
    money,
    total,
    usual,
    deltaPct: usual === null ? null : percent(total, usual),
    baselineMonths: baseline.length,
    above: shifts
      .filter((s) => s.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, MAX_ABOVE),
    below: shifts
      .filter((s) => s.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, MAX_BELOW),
    monthToDate: enough && slot > 1 ? monthToDate(txns, key, baseline, include, money) : null,
  };
}

/** The month's running total through this bucket against the same stretch of earlier months. */
function monthToDate(
  txns: Txn[],
  key: string,
  baselineKeys: string[],
  include: (txn: Txn) => boolean,
  money: Money,
): MonthToDate {
  const slot = Number(key.slice(-1));
  const upTo = (month: string) => Array.from({ length: slot }, (_, i) => `${month}-b${i + 1}`);
  const months = [key.slice(0, 7), ...baselineKeys.map((k) => k.slice(0, 7))];
  const totals = periodTotals(txns, months.flatMap(upTo), include, 'bucket', money);
  const running = (month: string) => upTo(month).reduce((sum, k) => sum + (totals.get(k) ?? 0), 0);

  const spent = running(key.slice(0, 7));
  const usual = median(baselineKeys.map((k) => running(k.slice(0, 7))));
  return {
    month: key.slice(0, 7),
    spent,
    usual,
    deltaPct: percent(spent, usual),
    throughDay: Number(bucketEnd(key).slice(8)),
    complete: slot === 4,
  };
}

// ─── caption ───────────────────────────────────────────────────────────────────────────

function percentText(deltaPct: number | null): string {
  if (deltaPct === null) return '';
  const rounded = Math.round(deltaPct);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return ` (${sign}${Math.abs(rounded)}%)`;
}

/**
 * The text under the recap picture: three or four short lines, HTML-escaped, within Telegram's
 * caption limit. The numbers are the same ones the picture and the sheet show.
 */
export function recapCaption(summary: BucketSummary, currency: MoneyCurrency): string {
  const amount = (value: number) => escapeHtml(formatMoney(Math.round(value), currency));
  const signed = (value: number) =>
    escapeHtml(`${value > 0 ? '+' : ''}${formatMoney(Math.round(value), currency)}`);
  const shifts = (items: CategoryShift[]) =>
    items.map((s) => `${escapeHtml(categoryLabel(s.category))} ${signed(s.delta)}`).join(', ');

  const headline =
    `🗓 Итоги ${bucketTitle(summary.key)}: ${amount(summary.total)}` +
    (summary.usual === null
      ? ''
      : ` · обычно ${amount(summary.usual)}${percentText(summary.deltaPct)}`);

  const lines = [headline];
  if (summary.above.length > 0) lines.push(`Больше обычного: ${shifts(summary.above)}`);
  if (summary.below.length > 0) lines.push(`Меньше: ${shifts(summary.below)}`);

  const mtd = summary.monthToDate;
  if (mtd) {
    const name = MONTHS_NOMINATIVE[Number(mtd.month.slice(5, 7)) - 1] ?? mtd.month;
    lines.push(
      mtd.complete
        ? `${name} в целом: ${amount(mtd.spent)} · обычно ${amount(mtd.usual)}${percentText(mtd.deltaPct)}`
        : `${name} пока: ${amount(mtd.spent)} · обычно к ${mtd.throughDay}-му ${amount(mtd.usual)}${percentText(mtd.deltaPct)}`,
    );
  }

  // Never cut inside a tag or entity: drop whole trailing lines until it fits
  while (lines.length > 1 && lines.join('\n').length > CAPTION_LIMIT) lines.pop();
  return lines.join('\n');
}

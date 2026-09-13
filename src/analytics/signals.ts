import { addDays } from '../domain/dates.js';
import { findAccount, type Reference } from '../domain/reference.js';
import type { Txn } from './dataset.js';
import {
  daysInMonth,
  isRegularExpense,
  median,
  monthLabel,
  periodLabel,
  periodTotals,
  recordedPeriods,
  shiftMonth,
  weekKey,
  weekKeyStart,
  weekStart,
  type Period,
} from './queries.js';

/**
 * What a review looks at: the last full week, the last full month, or the month so far.
 * Full periods are the default because a half-finished week always looks cheap.
 */
export type ReviewScope = 'week' | 'month' | 'mtd';

/** How many earlier periods define "обычно" — enough to smooth one odd period out. */
export const REVIEW_BASELINE: Record<ReviewScope, number> = { week: 8, month: 6, mtd: 6 };

/** Transfers into these groups count as money put aside, not spent. */
export const SAVINGS_GROUPS = ['Подушка', 'Накопления', 'Инвестиции'];

const MAX_BIG_TXNS = 6;
const UNCATEGORISED = 'Без категории';

export interface ReviewWindow {
  scope: ReviewScope;
  period: Period;
  key: string;
  /** How the period is named to the owner: «прошлая неделя 07–13.09». */
  title: string;
  from: string;
  to: string;
  /** Earlier periods of the same kind, oldest first. */
  baseline: string[];
  /** Set only for the month in progress. */
  daysPassed?: number;
  daysTotal?: number;
}

export function reviewWindow(today: string, scope: ReviewScope): ReviewWindow {
  const size = REVIEW_BASELINE[scope];

  if (scope === 'week') {
    const key = weekKey(addDays(weekStart(today), -7));
    const from = weekKeyStart(key);
    return {
      scope,
      period: 'week',
      key,
      title: `прошлая неделя ${periodLabel(key, 'week')}`,
      from,
      to: addDays(from, 6),
      baseline: Array.from({ length: size }, (_, i) => weekKey(addDays(from, (i - size) * 7))),
    };
  }

  const current = today.slice(0, 7);
  const key = scope === 'month' ? shiftMonth(current, -1) : current;
  const daysTotal = daysInMonth(key);
  const baseline = Array.from({ length: size }, (_, i) => shiftMonth(key, i - size));

  if (scope === 'month') {
    return {
      scope,
      period: 'month',
      key,
      title: `прошлый месяц (${monthLabel(key)})`,
      from: `${key}-01`,
      to: `${key}-${String(daysTotal).padStart(2, '0')}`,
      baseline,
    };
  }

  const daysPassed = Number(today.slice(8, 10));
  return {
    scope,
    period: 'month',
    key,
    title: `этот месяц пока (${monthLabel(key)}, ${daysPassed} из ${daysTotal} дней)`,
    from: `${key}-01`,
    to: today,
    baseline,
    daysPassed,
    daysTotal,
  };
}

export interface CategorySignal {
  category: string;
  actual: number;
  /** Median of the baseline periods, zeros included — "what a usual period costs". */
  typical: number;
  delta: number;
  /** null when there is no usual level to compare against. */
  deltaPct: number | null;
  /** Purchases now and in a usual period: separates "more often" from "more expensive". */
  count: number;
  typicalCount: number;
  avgTicket: number;
  typicalTicket: number;
  /** Consecutive periods, ending with this one, above the usual level: a trend, not a blip. */
  streakAbove: number;
  /** Spent now, never in the baseline. */
  isNew: boolean;
}

export interface TxnSignal {
  date: string;
  category: string;
  subcategory: string;
  usd: number;
  comment: string;
  oneOff: boolean;
  /** How many usual purchases in its category this one is worth; null if there is no usual. */
  timesTypical: number | null;
}

export interface ReviewSignals {
  window: ReviewWindow;
  /** Regular spending: no one-offs, no transfers between own accounts. */
  spent: number;
  typical: number;
  delta: number;
  deltaPct: number | null;
  txnCount: number;
  oneOff: number;
  income: number;
  /** Transfers into savings groups during the period. */
  saved: number;
  categories: CategorySignal[];
  bigTxns: TxnSignal[];
  /** Regular spending per period, baseline then current, for the chart. */
  history: { label: string; value: number }[];
  /** Month in progress only: where the month is heading at the usual pace. */
  projection?: { expected: number; typicalMonth: number };
}

/**
 * Which period a transaction belongs to within this review, or null if it is outside it.
 * A month in progress is compared with the same days of earlier months, not whole months:
 * rent paid on the 1st would otherwise make every early month look alarmingly expensive.
 */
function bucketOf(txn: Txn, window: ReviewWindow): string | null {
  const key = window.period === 'week' ? weekKey(txn.date) : txn.month;
  if (key !== window.key && !window.baseline.includes(key)) return null;
  if (window.daysPassed !== undefined && Number(txn.date.slice(8, 10)) > window.daysPassed) {
    return null;
  }
  return key;
}

/** The baseline minus periods the sheet has no (or only partial) records for. */
function trimToHistory(window: ReviewWindow, txns: Txn[]): ReviewWindow {
  return { ...window, baseline: recordedPeriods(window.baseline, txns, window.period) };
}

interface CategoryTally {
  total: Map<string, number>;
  count: Map<string, number>;
  baselineTickets: number[];
}

/**
 * Everything a review can say, computed before the model sees anything. The model's job is
 * to explain these numbers in plain words and connect them — never to produce them.
 */
export function buildReviewSignals(
  txns: Txn[],
  ref: Reference,
  today: string,
  scope: ReviewScope,
): ReviewSignals {
  const window = trimToHistory(reviewWindow(today, scope), txns);
  const periods = [...window.baseline, window.key];
  const totals = new Map(periods.map((key) => [key, 0]));
  const tallies = new Map<string, CategoryTally>();
  const current: Txn[] = [];
  let oneOff = 0;
  let income = 0;
  let saved = 0;
  let txnCount = 0;

  for (const txn of txns) {
    const bucket = bucketOf(txn, window);
    if (bucket === null) continue;
    const isCurrent = bucket === window.key;

    if (isCurrent) {
      if (txn.type === 'Доход') income += txn.usd;
      if (txn.type === 'Расход') current.push(txn);
      if (txn.type === 'Расход' && txn.oneOff) oneOff += txn.usd;
      const target = findAccount(ref, txn.toAccount);
      if (txn.type === 'Перевод' && target && SAVINGS_GROUPS.includes(target.group)) {
        saved += txn.usd;
      }
    }

    if (!isRegularExpense(txn)) continue;

    const name = txn.category || UNCATEGORISED;
    const tally: CategoryTally = tallies.get(name) ?? {
      total: new Map<string, number>(),
      count: new Map<string, number>(),
      baselineTickets: [],
    };
    tally.total.set(bucket, (tally.total.get(bucket) ?? 0) + txn.usd);
    tally.count.set(bucket, (tally.count.get(bucket) ?? 0) + 1);
    if (!isCurrent) tally.baselineTickets.push(txn.usd);
    tallies.set(name, tally);

    totals.set(bucket, (totals.get(bucket) ?? 0) + txn.usd);
    if (isCurrent) txnCount++;
  }

  const categories = [...tallies]
    .map(([category, tally]): CategorySignal => {
      const series = periods.map((key) => tally.total.get(key) ?? 0);
      const base = series.slice(0, -1);
      const actual = series.at(-1) ?? 0;
      const typical = median(base);
      const count = tally.count.get(window.key) ?? 0;

      let streakAbove = 0;
      for (let i = series.length - 1; i >= 0 && (series[i] ?? 0) > typical; i--) streakAbove++;

      return {
        category,
        actual,
        typical,
        delta: actual - typical,
        deltaPct: typical > 0 ? (actual - typical) / typical : null,
        count,
        typicalCount: median(window.baseline.map((key) => tally.count.get(key) ?? 0)),
        avgTicket: count > 0 ? actual / count : 0,
        typicalTicket: median(tally.baselineTickets),
        streakAbove,
        isNew: actual > 0 && base.every((value) => value === 0),
      };
    })
    .filter((signal) => signal.actual > 0 || signal.typical > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const usualTicket = new Map(categories.map((signal) => [signal.category, signal.typicalTicket]));
  const bigTxns = current
    .sort((a, b) => b.usd - a.usd)
    .slice(0, MAX_BIG_TXNS)
    .map((txn): TxnSignal => {
      const category = txn.category || UNCATEGORISED;
      const ticket = usualTicket.get(category) ?? 0;
      return {
        date: txn.date,
        category,
        subcategory: txn.subcategory,
        usd: txn.usd,
        comment: txn.comment,
        oneOff: txn.oneOff,
        timesTypical: ticket > 0 ? txn.usd / ticket : null,
      };
    });

  const spent = totals.get(window.key) ?? 0;
  const typical = median(window.baseline.map((key) => totals.get(key) ?? 0));

  const signals: ReviewSignals = {
    window,
    spent,
    typical,
    delta: spent - typical,
    deltaPct: typical > 0 ? (spent - typical) / typical : null,
    txnCount,
    oneOff,
    income,
    saved,
    categories,
    bigTxns,
    history: periods.map((key) => ({
      label: periodLabel(key, window.period),
      value: totals.get(key) ?? 0,
    })),
  };

  if (window.daysPassed !== undefined) {
    // Same-days typical is already in `typical`; the rest of a usual month is what is still coming
    const typicalMonth = median([
      ...periodTotals(txns, window.baseline, isRegularExpense).values(),
    ]);
    signals.projection = { typicalMonth, expected: spent + Math.max(typicalMonth - typical, 0) };
  }

  return signals;
}

// ─── prompt block ──────────────────────────────────────────────────────────────────────

/** «за 1 неделю», «за 3 недели», «за 6 месяцев» — the block is read back to the owner. */
function periodsWord(count: number, period: Period): string {
  const forms = period === 'week' ? ['неделю', 'недели', 'недель'] : ['месяц', 'месяца', 'месяцев'];
  const mod10 = count % 10;
  const mod100 = count % 100;
  const form =
    mod10 === 1 && mod100 !== 11
      ? forms[0]
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? forms[1]
        : forms[2];
  return `${count} ${form}`;
}

function usd(value: number): string {
  return `$${Math.round(value)}`;
}

function signedUsd(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}$${Math.abs(rounded)}`;
}

function pct(value: number | null): string {
  if (value === null) return 'нет обычного уровня';
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

const MAX_BLOCK_CATEGORIES = 12;

/** The signals as a prompt block. Labels say «обычно», the word the owner should hear too. */
export function reviewSignalsBlock(signals: ReviewSignals): string {
  const { window: w } = signals;
  const used = w.baseline.length;
  const sameDays =
    w.daysPassed === undefined ? '' : `, за те же первые ${w.daysPassed} дней месяца`;
  const usual =
    used === 0
      ? 'Сравнивать пока не с чем: раньше этого периода в таблице нет данных. Не придумывай «обычный» уровень — так и скажи владельцу.'
      : `«Обычно» — типичная сумма за ${periodsWord(used, w.period)} до этого (середина ряда, чтобы одна дорогая неделя не сбивала оценку)${sameDays}.` +
        (used < REVIEW_BASELINE[w.scope]
          ? ` Истории пока меньше обычного: сравнение только по ${periodsWord(used, w.period)} — скажи владельцу, что оценка приблизительная.`
          : '');
  const lines = [
    `ПЕРИОД: ${w.title}, ${w.from} — ${w.to}.`,
    usual,
    'Суммы в USD. Регулярные траты = без разовых покупок и без переводов между своими счетами. Владельцу говори просто «обычно».',
    '',
    `Потрачено регулярно: ${usd(signals.spent)} · обычно ${usd(signals.typical)} · разница ${signedUsd(signals.delta)} (${pct(signals.deltaPct)}) · покупок: ${signals.txnCount}`,
    `Разовые траты: ${usd(signals.oneOff)}`,
    `Доходы за период: ${usd(signals.income)}`,
    `Отложено (переводы на ${SAVINGS_GROUPS.join('/')}): ${usd(signals.saved)}`,
  ];

  if (signals.projection) {
    lines.push(
      `Прогноз на весь месяц при обычном темпе: ${usd(signals.projection.expected)} (обычный месяц целиком — ${usd(signals.projection.typicalMonth)})`,
    );
  }

  lines.push(
    '',
    'КАТЕГОРИИ, от самого большого отклонения (категория; сейчас; обычно; разница; %; покупок сейчас/обычно; средний чек сейчас/обычно; периодов подряд выше обычного; новая):',
    ...signals.categories
      .slice(0, MAX_BLOCK_CATEGORIES)
      .map((c) =>
        [
          c.category,
          usd(c.actual),
          usd(c.typical),
          signedUsd(c.delta),
          pct(c.deltaPct),
          `${c.count}/${Math.round(c.typicalCount)}`,
          `${usd(c.avgTicket)}/${usd(c.typicalTicket)}`,
          c.streakAbove,
          c.isNew ? 'да' : '',
        ].join(';'),
      ),
  );

  if (signals.bigTxns.length > 0) {
    lines.push(
      '',
      'САМЫЕ КРУПНЫЕ ТРАТЫ ПЕРИОДА (дата; категория; подкатегория; USD; во сколько раз дороже обычной покупки в категории; разовая; комментарий владельца):',
      ...signals.bigTxns.map((t) =>
        [
          t.date,
          t.category,
          t.subcategory,
          usd(t.usd),
          t.timesTypical === null ? '' : `×${t.timesTypical.toFixed(1)}`,
          t.oneOff ? 'да' : '',
          t.comment,
        ].join(';'),
      ),
    );
  }

  lines.push(
    '',
    'ДИНАМИКА регулярных трат по периодам (последний — разбираемый):',
    signals.history.map((point) => `${point.label}=${usd(point.value)}`).join(', '),
  );

  return lines.join('\n');
}

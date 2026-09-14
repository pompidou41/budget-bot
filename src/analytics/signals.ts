import { addDays, formatDateRu } from '../domain/dates.js';
import { findAccount, type Reference } from '../domain/reference.js';
import {
  cleanComment,
  composition,
  daysSinceSalary,
  isSummary,
  liveWeeks,
  moneyFlow,
  obligationKey,
  obligations,
  timeline,
  type CategoryComposition,
  type MoneyArrival,
  type Obligation,
} from './context.js';
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
const MAX_COMPOSITIONS = 5;
const MAX_BLOCK_CATEGORIES = 12;
const UNCATEGORISED = 'Без категории';
/** Fewer real weeks than this and a usual week is estimated from usual months instead. */
const MIN_LIVE_WEEKS = 2;
const WEEK_SHARE_OF_MONTH = 7 / 30.4;

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
  /** null when the baseline holds summary rows — period totals, not purchases. */
  typicalCount: number | null;
  avgTicket: number;
  typicalTicket: number | null;
  /** Consecutive periods, ending with this one, above the usual level: a trend, not a blip. */
  streakAbove: number | null;
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
  /** Why «обычно» is only an estimate: a week judged from months, or earlier months kept as summaries. */
  approximate?: 'monthly' | 'summaries';
  /** First real operation, when the comparison still leans on summaries from before it. */
  liveSince?: string;
  /** Regular spending that went to obligations — rent, utilities, connection, subscriptions, loans. */
  fixed: number;
  /** Everything else: the part of spending that day-to-day choices actually move. */
  flexible: number;
  obligations: Obligation[];
  /** Money that came in around the period and how it was laid out. */
  money: MoneyArrival[];
  daysSinceSalary?: number;
  /** Subcategories, places and people behind the categories that moved most. */
  compositions: CategoryComposition[];
  /** Day-by-day real operations; for a week and for the month in progress. */
  timeline: string[];
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

/**
 * The baseline minus periods the sheet has no (or only partial) records for. Weeks go further:
 * the imported history keeps period totals dated the 1st/9th/17th/25th, so a week with such a
 * row looks huge and the weeks between them look empty. Neither is a real week, so weekly
 * baselines start at the first real operation and skip any week holding a summary.
 */
function trimToHistory(window: ReviewWindow, txns: Txn[], ref: Reference): ReviewWindow {
  if (window.period !== 'week') {
    return { ...window, baseline: recordedPeriods(window.baseline, txns, window.period) };
  }
  return { ...window, baseline: liveWeeks(window.baseline, txns, ref) };
}

/** Usual regular spending per month, in total and per category, over `months`. */
function monthlyUsual(
  txns: Txn[],
  months: string[],
): { total: number; byCategory: Map<string, number> } {
  const perMonth = new Map(months.map((month) => [month, 0]));
  const perCategory = new Map<string, Map<string, number>>();
  for (const t of txns) {
    if (!perMonth.has(t.month) || !isRegularExpense(t)) continue;
    perMonth.set(t.month, (perMonth.get(t.month) ?? 0) + t.usd);
    const name = t.category || UNCATEGORISED;
    const byMonth = perCategory.get(name) ?? new Map<string, number>();
    byMonth.set(t.month, (byMonth.get(t.month) ?? 0) + t.usd);
    perCategory.set(name, byMonth);
  }
  return {
    total: median([...perMonth.values()]),
    byCategory: new Map(
      [...perCategory].map(([name, byMonth]) => [
        name,
        median(months.map((month) => byMonth.get(month) ?? 0)),
      ]),
    ),
  };
}

interface CategoryTally {
  total: Map<string, number>;
  count: Map<string, number>;
  baselineTickets: number[];
}

function emptyTally(): CategoryTally {
  return {
    total: new Map<string, number>(),
    count: new Map<string, number>(),
    baselineTickets: [],
  };
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
  const window = trimToHistory(reviewWindow(today, scope), txns, ref);
  const periods = [...window.baseline, window.key];
  const totals = new Map(periods.map((key) => [key, 0]));
  const tallies = new Map<string, CategoryTally>();
  /** Regular spending per category per period, kept whole for the composition of each category. */
  const categoryTxns = new Map<string, Map<string, Txn[]>>();
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
    const tally = tallies.get(name) ?? emptyTally();
    tally.total.set(bucket, (tally.total.get(bucket) ?? 0) + txn.usd);
    tally.count.set(bucket, (tally.count.get(bucket) ?? 0) + 1);
    if (!isCurrent) tally.baselineTickets.push(txn.usd);
    tallies.set(name, tally);

    const perPeriod = categoryTxns.get(name) ?? new Map<string, Txn[]>();
    perPeriod.set(bucket, [...(perPeriod.get(bucket) ?? []), txn]);
    categoryTxns.set(name, perPeriod);

    totals.set(bucket, (totals.get(bucket) ?? 0) + txn.usd);
    if (isCurrent) txnCount++;
  }

  // Months before the reviewed period: the basis for obligations and for estimated weeks
  const priorMonths = recordedPeriods(
    Array.from({ length: REVIEW_BASELINE.month }, (_, i) =>
      shiftMonth(window.from.slice(0, 7), i - REVIEW_BASELINE.month),
    ),
    txns,
    'month',
  );
  // Too few real weeks to know a usual week: estimate one from usual months, if there are any
  const usualMonth =
    window.period === 'week' && window.baseline.length < MIN_LIVE_WEEKS && priorMonths.length > 0
      ? monthlyUsual(txns, priorMonths)
      : undefined;

  const baselineKeys = new Set(window.baseline);
  const baselineHasSummaries =
    usualMonth !== undefined ||
    txns.some(
      (t) =>
        isSummary(t, ref) && baselineKeys.has(window.period === 'week' ? weekKey(t.date) : t.month),
    );

  const names = new Set([...tallies.keys(), ...(usualMonth?.byCategory.keys() ?? [])]);
  const categories = [...names]
    .map((category): CategorySignal => {
      const tally = tallies.get(category) ?? emptyTally();
      const series = periods.map((key) => tally.total.get(key) ?? 0);
      const base = series.slice(0, -1);
      const actual = series.at(-1) ?? 0;
      const count = tally.count.get(window.key) ?? 0;
      const avgTicket = count > 0 ? actual / count : 0;

      if (usualMonth) {
        const typical = (usualMonth.byCategory.get(category) ?? 0) * WEEK_SHARE_OF_MONTH;
        return {
          category,
          actual,
          typical,
          delta: actual - typical,
          deltaPct: typical > 0 ? (actual - typical) / typical : null,
          count,
          typicalCount: null,
          avgTicket,
          typicalTicket: null,
          streakAbove: null,
          isNew: actual > 0 && typical === 0,
        };
      }

      const typical = median(base);
      let streakAbove = 0;
      for (let i = series.length - 1; i >= 0 && (series[i] ?? 0) > typical; i--) streakAbove++;

      return {
        category,
        actual,
        typical,
        delta: actual - typical,
        deltaPct: typical > 0 ? (actual - typical) / typical : null,
        count,
        // A summary row is a period total, not a purchase: counting it would invent "fewer,
        // bigger purchases" that never happened
        typicalCount: baselineHasSummaries
          ? null
          : median(window.baseline.map((key) => tally.count.get(key) ?? 0)),
        avgTicket,
        typicalTicket: baselineHasSummaries ? null : median(tally.baselineTickets),
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
      const ticket = usualTicket.get(category) ?? null;
      return {
        date: txn.date,
        category,
        subcategory: txn.subcategory,
        usd: txn.usd,
        comment: cleanComment(txn.comment),
        oneOff: txn.oneOff,
        timesTypical: ticket ? txn.usd / ticket : null,
      };
    });

  const spent = totals.get(window.key) ?? 0;
  const typical = usualMonth
    ? usualMonth.total * WEEK_SHARE_OF_MONTH
    : median(window.baseline.map((key) => totals.get(key) ?? 0));

  const fixed = [...categoryTxns.values()]
    .flatMap((perPeriod) => perPeriod.get(window.key) ?? [])
    .filter((t) => obligationKey(t) !== null)
    .reduce((sum, t) => sum + t.usd, 0);

  const approximate = usualMonth
    ? 'monthly'
    : window.daysPassed !== undefined && baselineHasSummaries
      ? 'summaries'
      : undefined;

  const compositions = categories
    .filter((signal) => signal.actual > 0)
    .slice(0, MAX_COMPOSITIONS)
    .map((signal) => {
      const perPeriod = categoryTxns.get(signal.category) ?? new Map<string, Txn[]>();
      // An estimated week has no real weeks to compare subcategories with
      const baseline = usualMonth ? [] : window.baseline.map((key) => perPeriod.get(key) ?? []);
      return composition(signal.category, perPeriod.get(window.key) ?? [], baseline, ref);
    });

  const firstLive = txns
    .filter((t) => !isSummary(t, ref))
    .reduce<
      string | undefined
    >((min, t) => (min === undefined || t.date < min ? t.date : min), undefined);

  // Money that arrived just before the period often explains what happened in it
  const flowFrom =
    window.period === 'week' ? addDays(window.from, -7) : `${shiftMonth(window.key, -1)}-01`;

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
    approximate,
    liveSince: baselineHasSummaries ? firstLive : undefined,
    fixed,
    flexible: spent - fixed,
    obligations: obligations(txns, priorMonths),
    money: moneyFlow(txns, ref, flowFrom, window.to),
    daysSinceSalary: daysSinceSalary(txns, window.to),
    compositions,
    timeline: window.scope === 'month' ? [] : timeline(txns, ref, window.from, window.to),
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

function dayMonth(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

function usualSentence(signals: ReviewSignals): string {
  const { window: w } = signals;
  const used = w.baseline.length;

  if (signals.approximate === 'monthly') {
    return '«Обычно» за неделю — примерная доля обычного месяца: живых операций по неделям пока мало.';
  }
  if (used === 0) {
    return 'Сравнивать пока не с чем: раньше этого периода в таблице нет данных. Не придумывай «обычный» уровень — так и скажи владельцу.';
  }
  const sameDays =
    w.daysPassed === undefined ? '' : `, за те же первые ${w.daysPassed} дней месяца`;
  const short =
    used < REVIEW_BASELINE[w.scope]
      ? ` Истории пока меньше обычного (учтено периодов: ${used}) — скажи владельцу, что оценка приблизительная.`
      : '';
  return `«Обычно» — типичная сумма за ${periodsWord(used, w.period)} до этого (середина ряда, чтобы один дорогой период не сбивал оценку)${sameDays}.${short}`;
}

/** The signals as a prompt block. Labels say «обычно», the word the owner should hear too. */
export function reviewSignalsBlock(signals: ReviewSignals): string {
  const { window: w } = signals;
  const usualColumn =
    w.daysPassed === undefined
      ? 'обычно'
      : `обычно к ${w.daysPassed}-му дню месяца (не за весь месяц)`;
  const lines = [
    `ПЕРИОД: ${w.title}, ${w.from} — ${w.to}.`,
    usualSentence(signals),
    'Суммы в USD. Регулярные траты = без разовых покупок и без переводов между своими счетами. Владельцу говори просто «обычно».',
    '',
    `Потрачено регулярно: ${usd(signals.spent)} · ${usualColumn} ${usd(signals.typical)} · разница ${signedUsd(signals.delta)} (${pct(signals.deltaPct)}) · покупок: ${signals.txnCount}`,
    `Разовые траты: ${usd(signals.oneOff)}`,
    `Доходы за период: ${usd(signals.income)}`,
    `Отложено (переводы на ${SAVINGS_GROUPS.join('/')}): ${usd(signals.saved)}`,
  ];

  if (signals.approximate) {
    lines.push(
      signals.approximate === 'summaries'
        ? 'ВАЖНО: прошлые месяцы записаны общими итогами, без отдельных покупок, поэтому сравнение «за те же дни» примерное.'
        : 'ВАЖНО: сравнение недели с обычным уровнем примерное.',
      'Не делай из разницы с «обычно» главный вывод: скажи «примерно» одной фразой, а заголовок и рассказ строй на том, что видно по живым операциям — откуда пришли и куда ушли деньги, на что и на кого тратил.',
    );
  }
  if (signals.liveSince) {
    lines.push(
      `Живые операции (с местами и людьми) записываются с ${formatDateRu(signals.liveSince)}. Если какой-то привычной статьи в них пока нет, её могли ещё не вносить или платежа не было — не утверждай, что трат не было.`,
    );
  }
  if (signals.fixed > 0) {
    lines.push(
      `Из регулярных трат обязательные платежи: ${usd(signals.fixed)}; свободные траты: ${usd(signals.flexible)}.`,
    );
  }
  if (signals.projection) {
    lines.push(
      `Прогноз на весь месяц при обычном темпе: ${usd(signals.projection.expected)} (обычный месяц целиком — ${usd(signals.projection.typicalMonth)})`,
    );
  }

  lines.push(
    '',
    `КАТЕГОРИИ, от самого большого отклонения (категория; сейчас; ${usualColumn}; разница; %; покупок сейчас/обычно; средний чек сейчас/обычно; периодов подряд выше обычного; новая). «—» — сравнивать не с чем:`,
    ...signals.categories
      .slice(0, MAX_BLOCK_CATEGORIES)
      .map((c) =>
        [
          c.category,
          usd(c.actual),
          usd(c.typical),
          signedUsd(c.delta),
          pct(c.deltaPct),
          `${c.count}/${c.typicalCount === null ? '—' : Math.round(c.typicalCount)}`,
          `${usd(c.avgTicket)}/${c.typicalTicket === null ? '—' : usd(c.typicalTicket)}`,
          c.streakAbove === null ? '—' : c.streakAbove,
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
    'ДЕНЬГИ — что пришло и как это разложили (график поступлений может меняться, дату следующего не прогнозируй):',
  );
  if (signals.money.length === 0) lines.push('Заметных поступлений в это время не было.');
  for (const arrival of signals.money) {
    const moves = arrival.moves.map(
      (m) => `${dayMonth(m.date)} ${m.to}${m.group ? ` (${m.group})` : ''} ${usd(m.usd)}`,
    );
    const where = arrival.account ? ` на ${arrival.account}` : '';
    const laidOut = moves.length > 0 ? ` → ${moves.join('; ')}` : '';
    lines.push(`${dayMonth(arrival.date)} ${arrival.what} ${usd(arrival.usd)}${where}${laidOut}`);
  }
  const laidOut = new Map<string, number>();
  for (const arrival of signals.money) {
    for (const move of arrival.moves) {
      // A hop between everyday cards is not laying money out
      if (move.group === 'Текущие') continue;
      laidOut.set(move.to, (laidOut.get(move.to) ?? 0) + move.usd);
    }
  }
  if (laidOut.size > 0) {
    lines.push(
      `Итого разложено за это время (уже посчитано — не складывай сам): ${[...laidOut]
        .map(([to, total]) => `${to} ${usd(total)}`)
        .join('; ')}.`,
    );
  }
  if (signals.daysSinceSalary !== undefined) {
    lines.push(`С последней зарплаты прошло дней: ${signals.daysSinceSalary}.`);
  }

  if (signals.obligations.length > 0) {
    lines.push(
      '',
      'ОБЯЗАТЕЛЬНЫЕ ПЛАТЕЖИ — аренда, коммуналка, связь, подписки, кредиты (что это; категория; обычно в месяц; в скольких месяцах из последних):',
      ...signals.obligations.map((p) =>
        [p.label, p.category, usd(p.typicalMonthly), p.monthsSeen].join(';'),
      ),
    );
  }

  if (signals.compositions.length > 0) {
    lines.push('', 'ИЗ ЧЕГО СОСТОЯТ КАТЕГОРИИ С НАИБОЛЬШИМ ОТКЛОНЕНИЕМ:');
    for (const c of signals.compositions) {
      const subs = c.subcategories
        .map(
          (sub) =>
            `${sub.name} ${usd(sub.actual)}${sub.typical === null ? '' : ` (обычно ${usd(sub.typical)})`}`,
        )
        .join(', ');
      const places = c.places
        .map(
          (place) => `${place.label}${place.count > 1 ? ` ×${place.count}` : ''} ${usd(place.usd)}`,
        )
        .join('; ');
      lines.push(
        `${c.category}: подкатегории — ${subs || 'нет'}${places ? `; места и люди — ${places}` : ''}`,
      );
    }
  }

  if (signals.timeline.length > 0) {
    lines.push('', 'ЛЕНТА ПО ДНЯМ (живые операции; «+» — поступление):', ...signals.timeline);
  }

  lines.push(
    '',
    'ДИНАМИКА регулярных трат по периодам (последний — разбираемый):',
    signals.history.map((point) => `${point.label}=${usd(point.value)}`).join(', '),
  );

  return lines.join('\n');
}

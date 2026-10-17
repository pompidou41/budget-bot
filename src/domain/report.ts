import type { Txn } from '../analytics/dataset.js';
import {
  buildMatrix,
  byCategory,
  periodKey,
  periodLabel,
  periodTotals,
  recentPeriods,
  sumMoney,
  type MatrixRow,
  type Money,
} from '../analytics/queries.js';
import { renderBars } from './bars.js';
import { escapeHtml, escapeRich, formatMoney, type MoneyCurrency } from './format.js';
import type { Reference } from './reference.js';

/**
 * What `/report` can slice by: the owner's «недели» (days 1–8, 9–16, 17–24, 25–end of each
 * month) or calendar months. ISO weeks stay in `/review` and `/ask`.
 */
export type ReportPeriod = 'bucket' | 'month';

/** What a `/report` screen is showing. */
export interface ReportState {
  period: ReportPeriod;
  /** How many periods back the table covers. */
  count: number;
  /** Category names to keep; empty means "no filter", i.e. every non-zero category. */
  categories: string[];
  /** One-off purchases are excluded by default, the way the rest of the analytics treats them. */
  oneOff: boolean;
  /** Amounts are shown in this currency; rubles are converted day by day (`Txn.rub`). */
  currency: MoneyCurrency;
}

// The owner's money and his old sheet are in rubles; dollars are one tap away
export const DEFAULT_REPORT: ReportState = {
  period: 'bucket',
  count: 8,
  categories: [],
  oneOff: false,
  currency: 'RUB',
};

export const COUNT_CHOICES: Record<ReportPeriod, number[]> = {
  bucket: [4, 8, 12, 24],
  month: [3, 6, 12, 24],
};

/** The amount to add up in the aggregates for the screen's currency. */
export function moneyOf(state: ReportState): Money {
  return state.currency === 'RUB' ? 'rub' : 'usd';
}

/** A bucket window is counted in buckets (four a month), but the owner thinks in months. */
export function countLabel(period: ReportPeriod, count: number): string {
  return `${period === 'bucket' ? count / 4 : count} мес`;
}

/** The currency switch names where it leads, like «+ разовые» does. */
export function currencyLabel(state: ReportState): string {
  return state.currency === 'USD' ? '₽ в рублях' : '$ в долларах';
}

export function otherCurrency(state: ReportState): MoneyCurrency {
  return state.currency === 'USD' ? 'RUB' : 'USD';
}

/**
 * Periods shown side by side in one table. Telegram lays a table out horizontally, so a wide
 * matrix is split across several tables rather than squeezed past legibility.
 */
export const MAX_TABLE_PERIODS = 6;

export interface ReportData {
  /** One row per selected category, heaviest first; already free of empty rows. */
  rows: MatrixRow[];
  totals: Map<string, number>;
  periods: string[];
  /** Every category in the sheet, in sheet order — the stable basis of the callback mask. */
  allCategories: string[];
  /** One-off spending in the window, reported separately while `oneOff` is off. */
  oneOffTotal: number;
}

export function categoryNames(ref: Reference): string[] {
  return ref.categories.map((category) => category.name);
}

/** Everything the screen shows, computed here so the model is never in this path. */
export function buildReportData(
  txns: Txn[],
  ref: Reference,
  today: string,
  state: ReportState,
): ReportData {
  const periods = recentPeriods(today, state.period, state.count);
  const window = new Set(periods);
  const selected = new Set(state.categories);
  const money = moneyOf(state);

  const include = (txn: Txn): boolean =>
    txn.type === 'Расход' &&
    (state.oneOff || !txn.oneOff) &&
    (selected.size === 0 || selected.has(txn.category));

  const rows = byCategory(buildMatrix(txns, periods, include, state.period, money)).filter(
    (row) => row.total > 0,
  );

  const oneOffTotal = sumMoney(
    txns.filter(
      (txn) =>
        txn.type === 'Расход' &&
        txn.oneOff &&
        window.has(periodKey(txn.date, state.period)) &&
        (selected.size === 0 || selected.has(txn.category)),
    ),
    money,
  );

  return {
    rows,
    totals: periodTotals(txns, periods, include, state.period, money),
    periods,
    allCategories: categoryNames(ref),
    oneOffTotal,
  };
}

function money(value: number, currency: MoneyCurrency): string {
  return formatMoney(Math.round(value), currency);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Which periods share a table. Buckets go a month per table — the four columns of the owner's
 * old sheet, with that month's total in Σ — and months go {@link MAX_TABLE_PERIODS} at a time.
 */
export function splitPeriods(periods: string[], period: ReportPeriod): string[][] {
  if (period === 'month') return chunk(periods, MAX_TABLE_PERIODS);

  const groups: string[][] = [];
  for (const key of periods) {
    const last = groups.at(-1);
    // `2026-10-b2` → `2026-10`
    if (last && last[0]?.slice(0, 7) === key.slice(0, 7)) last.push(key);
    else groups.push([key]);
  }
  return groups;
}

// ─── callback codec ────────────────────────────────────────────────────────────────────

export const REPORT_PREFIX = 'r:';
/** Same body as {@link REPORT_PREFIX}, a different handler: the heatmap picture of the screen. */
export const REPORT_IMAGE_PREFIX = 'ri:';

const PERIOD_CODES: Record<ReportPeriod, string> = { bucket: 'b', month: 'm' };

/** The button that turns the table into the heatmap picture. */
export const PICTURE_LABEL = '🖼 Картинка';

/**
 * `<b|m><count>:<mask>:<flags>`. Flags are a letter set — `o` one-offs included, `r` rubles —
 * or `-` for none. Buttons sent before the currency switch carry only `o` or `-`, which still decode.
 */
function encodeBody(state: ReportState, allCategories: string[]): string {
  const mask = state.categories.length === 0 ? '-' : maskOf(state.categories, allCategories);
  const flags = `${state.oneOff ? 'o' : ''}${state.currency === 'RUB' ? 'r' : ''}` || '-';
  return `${PERIOD_CODES[state.period]}${state.count}:${mask}:${flags}`;
}

/**
 * The whole screen state travels in the callback data, so a report keeps working after a
 * restart with no server-side session. Categories become a bitmask over the sheet's own
 * category order — a base-36 mask stays a handful of characters, where names would blow
 * past Telegram's 64-byte limit after two of them.
 */
export function encodeReport(state: ReportState, allCategories: string[]): string {
  return `${REPORT_PREFIX}${encodeBody(state, allCategories)}`;
}

export function encodeReportImage(state: ReportState, allCategories: string[]): string {
  return `${REPORT_IMAGE_PREFIX}${encodeBody(state, allCategories)}`;
}

/** Reads either prefix; the caller's callback pattern decides which handler gets the data. */
export function decodeReport(data: string, allCategories: string[]): ReportState | null {
  const prefix = [REPORT_PREFIX, REPORT_IMAGE_PREFIX].find((p) => data.startsWith(p));
  if (!prefix) return null;
  const [head, mask, flags] = data.slice(prefix.length).split(':');
  if (!head || mask === undefined || flags === undefined) return null;

  let count = Number(head.slice(1));
  if (!Number.isInteger(count) || count < 1 || count > 60) return null;

  let period: ReportPeriod;
  switch (head[0]) {
    case 'b':
      period = 'bucket';
      break;
    case 'm':
      period = 'month';
      break;
    case 'w':
      // Buttons from before the buckets: ISO weeks are gone from the screen, the nearest thing is
      period = 'bucket';
      if (!COUNT_CHOICES.bucket.includes(count)) count = DEFAULT_REPORT.count;
      break;
    default:
      return null;
  }

  return {
    period,
    count,
    categories: mask === '-' ? [] : fromMask(mask, allCategories),
    oneOff: flags.includes('o'),
    currency: flags.includes('r') ? 'RUB' : 'USD',
  };
}

function maskOf(categories: string[], allCategories: string[]): string {
  const selected = new Set(categories);
  let mask = 0n;
  allCategories.forEach((name, i) => {
    if (selected.has(name)) mask |= 1n << BigInt(i);
  });
  return mask.toString(36);
}

function fromMask(mask: string, allCategories: string[]): string[] {
  let value: bigint;
  try {
    value = [...mask].reduce((acc, char) => acc * 36n + BigInt(parseInt(char, 36)), 0n);
  } catch {
    return [];
  }
  return allCategories.filter((_, i) => (value >> BigInt(i)) & 1n);
}

/** Adds or removes one category, normalising "all of them selected" back to "no filter". */
export function toggleCategory(current: string[], name: string, available: string[]): string[] {
  const selected = new Set(current.length > 0 ? current : available);
  if (selected.has(name)) selected.delete(name);
  else selected.add(name);
  if (selected.size === 0 || selected.size === available.length) return [];
  return available.filter((c) => selected.has(c));
}

// ─── shared copy ───────────────────────────────────────────────────────────────────────

function title(state: ReportState): string {
  const unit = state.period === 'bucket' ? 'неделям' : 'месяцам';
  return `Расходы по ${unit}${state.oneOff ? '' : ', без разовых'}`;
}

function subtitle(state: ReportState, data: ReportData): string {
  const scope = state.categories.length > 0 ? `${state.categories.length} катег.` : 'все категории';
  const unit = state.period === 'bucket' ? 'нед.' : 'мес.';
  return `${data.periods.length} ${unit} · ${scope} · ${state.currency}`;
}

function windowTotal(row: MatrixRow, periods: string[]): number {
  return periods.reduce((sum, key) => sum + (row.byPeriod.get(key) ?? 0), 0);
}

function trendBars(data: ReportData, state: ReportState): string {
  return renderBars(
    data.periods.map((key) => ({
      label: periodLabel(key, state.period),
      value: data.totals.get(key) ?? 0,
    })),
    (value) => money(value, state.currency),
  );
}

function oneOffNote(state: ReportState, data: ReportData): string {
  if (state.oneOff || data.oneOffTotal <= 0) return '';
  return `Разовые траты за период: ${money(data.oneOffTotal, state.currency)} — в таблицу не входят.`;
}

const EMPTY = 'За выбранный период трат нет.';

// ─── rich rendering ────────────────────────────────────────────────────────────────────

function cell(text: string, header: boolean, align: 'left' | 'right'): string {
  const tag = header ? 'th' : 'td';
  return `<${tag} align="${align}">${escapeRich(text)}</${tag}>`;
}

function richTable(data: ReportData, periods: string[], state: ReportState): string {
  const fmt = (value: number) => money(value, state.currency);
  const head = [
    cell('Категория', true, 'left'),
    ...periods.map((key) => cell(periodLabel(key, state.period), true, 'right')),
    cell('Σ', true, 'right'),
  ].join('');

  const body = data.rows.map((row) => {
    const cells = periods.map((key) => {
      const value = row.byPeriod.get(key);
      // A dash reads as "nothing here" far faster than a column of $0
      return cell(value ? fmt(value) : '—', false, 'right');
    });
    const total = cell(fmt(windowTotal(row, periods)), false, 'right');
    return `<tr>${cell(row.category, false, 'left')}${cells.join('')}${total}</tr>`;
  });

  const sum = periods.reduce((acc, key) => acc + (data.totals.get(key) ?? 0), 0);
  const footer = `<tr>${cell('Итого', true, 'left')}${periods
    .map((key) => cell(fmt(data.totals.get(key) ?? 0), true, 'right'))
    .join('')}${cell(fmt(sum), true, 'right')}</tr>`;

  return `<table bordered striped compact><tr>${head}</tr>${body.join('')}${footer}</table>`;
}

function richButton(label: string, data: string, active: boolean): string {
  // The current choice stays visible but unclickable, so the screen shows its own state
  return active
    ? `<tg-button type="disabled" style="primary">${escapeRich(label)}</tg-button>`
    : `<tg-button type="callback_data" data="${escapeRich(data)}">${escapeRich(label)}</tg-button>`;
}

function richPicker(state: ReportState, data: ReportData): string {
  if (data.allCategories.length === 0) return '';
  const selected = new Set(state.categories);
  const all = selected.size === 0;

  const buttons = data.allCategories.map((name) => {
    const next = {
      ...state,
      categories: toggleCategory(state.categories, name, data.allCategories),
    };
    const mark = all || selected.has(name) ? '☑' : '☐';
    return richButton(`${mark} ${name}`, encodeReport(next, data.allCategories), false);
  });

  // Rich button rows hold up to eight; three keeps category names readable
  const rows = chunk(buttons, 3).map((group) => `<tg-button-row>${group.join('')}</tg-button-row>`);
  const reset = all
    ? ''
    : `<tg-button-row>${richButton('Показать все', encodeReport({ ...state, categories: [] }, data.allCategories), false)}</tg-button-row>`;

  return `<details><summary>Выбрать категории</summary>${rows.join('')}${reset}</details>`;
}

function richControls(state: ReportState, data: ReportData): string {
  const enc = (next: Partial<ReportState>) =>
    encodeReport({ ...state, ...next }, data.allCategories);

  const periods = [
    richButton(
      'Недели',
      enc({ period: 'bucket', count: DEFAULT_REPORT.count }),
      state.period === 'bucket',
    ),
    richButton('Месяцы', enc({ period: 'month', count: 6 }), state.period === 'month'),
  ].join('');

  const counts = COUNT_CHOICES[state.period]
    .map((n) => richButton(countLabel(state.period, n), enc({ count: n }), n === state.count))
    .join('');

  const switches = [
    richButton(state.oneOff ? '− разовые' : '+ разовые', enc({ oneOff: !state.oneOff }), false),
    richButton(currencyLabel(state), enc({ currency: otherCurrency(state) }), false),
  ].join('');

  const picture = richButton(PICTURE_LABEL, encodeReportImage(state, data.allCategories), false);

  return [periods, counts, switches, picture]
    .map((row) => `<tg-button-row>${row}</tg-button-row>`)
    .join('');
}

export function renderReportRich(state: ReportState, data: ReportData): string {
  const header = `<h3>📊 ${escapeRich(title(state))}</h3><p>${escapeRich(subtitle(state, data))}</p>`;

  if (data.rows.length === 0) {
    return `${header}<p>${escapeRich(EMPTY)}</p>${richControls(state, data)}`;
  }

  const tables = splitPeriods(data.periods, state.period)
    .map((slice) => richTable(data, slice, state))
    .join('');
  const note = oneOffNote(state, data);

  return [
    header,
    tables,
    `<details><summary>Динамика итогов</summary>${trendBars(data, state)}</details>`,
    note ? `<p>${escapeRich(note)}</p>` : '',
    richPicker(state, data),
    richControls(state, data),
  ].join('');
}

// ─── plain HTML fallback ───────────────────────────────────────────────────────────────

function pad(text: string, width: number, right: boolean): string {
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return right ? clipped.padStart(width) : clipped.padEnd(width);
}

const NAME_WIDTH = 12;

/** The same numbers as a monospace block, for when rich rendering is off or refused. */
export function renderReportHtml(state: ReportState, data: ReportData): string {
  const header = `📊 <b>${escapeHtml(title(state))}</b>\n<i>${escapeHtml(subtitle(state, data))}</i>`;
  if (data.rows.length === 0) return `${header}\n\n${escapeHtml(EMPTY)}`;

  const columns = data.periods.map((key) => periodLabel(key, state.period));
  const width = Math.max(...columns.map((c) => c.length), 7);

  const lines = [
    [pad('Категория', NAME_WIDTH, false), ...columns.map((c) => pad(c, width, true))].join(' '),
    ...data.rows.map((row) =>
      [
        pad(row.category, NAME_WIDTH, false),
        ...data.periods.map((key) => {
          const value = row.byPeriod.get(key);
          return pad(value ? money(value, state.currency) : '—', width, true);
        }),
      ].join(' '),
    ),
    [
      pad('Итого', NAME_WIDTH, false),
      ...data.periods.map((key) =>
        pad(money(data.totals.get(key) ?? 0, state.currency), width, true),
      ),
    ].join(' '),
  ];

  const note = oneOffNote(state, data);
  return [
    header,
    `<pre>${escapeHtml(lines.join('\n'))}</pre>`,
    trendBars(data, state),
    note ? `<i>${escapeHtml(note)}</i>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

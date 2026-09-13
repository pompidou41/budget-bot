import { periodLabel, type MatrixRow, type Period } from '../analytics/queries.js';
import { renderBars } from './bars.js';
import { escapeHtml, escapeRich, formatUsd } from './format.js';

/** What a `/report` screen is showing. */
export interface ReportState {
  period: Period;
  /** How many periods back the table covers. */
  count: number;
  /** Category names to keep; empty means "no filter", i.e. every non-zero category. */
  categories: string[];
  /** One-off purchases are excluded by default, the way the rest of the analytics treats them. */
  oneOff: boolean;
}

export const DEFAULT_REPORT: ReportState = {
  period: 'week',
  count: 8,
  categories: [],
  oneOff: false,
};

export const COUNT_CHOICES: Record<Period, number[]> = {
  week: [4, 8, 12, 24],
  month: [3, 6, 12, 24],
};

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

function money(value: number): string {
  return formatUsd(Math.round(value));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── callback codec ────────────────────────────────────────────────────────────────────

export const REPORT_PREFIX = 'r:';

/**
 * The whole screen state travels in the callback data, so a report keeps working after a
 * restart with no server-side session. Categories become a bitmask over the sheet's own
 * category order — a base-36 mask stays a handful of characters, where names would blow
 * past Telegram's 64-byte limit after two of them.
 */
export function encodeReport(state: ReportState, allCategories: string[]): string {
  const mask = state.categories.length === 0 ? '-' : maskOf(state.categories, allCategories);
  return `${REPORT_PREFIX}${state.period[0]}${state.count}:${mask}:${state.oneOff ? 'o' : '-'}`;
}

export function decodeReport(data: string, allCategories: string[]): ReportState | null {
  if (!data.startsWith(REPORT_PREFIX)) return null;
  const [head, mask, flags] = data.slice(REPORT_PREFIX.length).split(':');
  if (!head || mask === undefined || flags === undefined) return null;

  const period: Period = head.startsWith('w') ? 'week' : 'month';
  const count = Number(head.slice(1));
  if (!Number.isInteger(count) || count < 1 || count > 60) return null;

  return {
    period,
    count,
    categories: mask === '-' ? [] : fromMask(mask, allCategories),
    oneOff: flags === 'o',
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
  const unit = state.period === 'week' ? 'неделям' : 'месяцам';
  return `Расходы по ${unit}${state.oneOff ? '' : ', без разовых'}`;
}

function subtitle(state: ReportState, data: ReportData): string {
  const scope = state.categories.length > 0 ? `${state.categories.length} катег.` : 'все категории';
  return `${data.periods.length} ${state.period === 'week' ? 'нед.' : 'мес.'} · ${scope} · USD`;
}

function windowTotal(row: MatrixRow, periods: string[]): number {
  return periods.reduce((sum, key) => sum + (row.byPeriod.get(key) ?? 0), 0);
}

function trendBars(data: ReportData, period: Period): string {
  return renderBars(
    data.periods.map((key) => ({
      label: periodLabel(key, period),
      value: data.totals.get(key) ?? 0,
    })),
    money,
  );
}

function oneOffNote(state: ReportState, data: ReportData): string {
  if (state.oneOff || data.oneOffTotal <= 0) return '';
  return `Разовые траты за период: ${money(data.oneOffTotal)} — в таблицу не входят.`;
}

const EMPTY = 'За выбранный период трат нет.';

// ─── rich rendering ────────────────────────────────────────────────────────────────────

function cell(text: string, header: boolean, align: 'left' | 'right'): string {
  const tag = header ? 'th' : 'td';
  return `<${tag} align="${align}">${escapeRich(text)}</${tag}>`;
}

function richTable(data: ReportData, periods: string[], period: Period): string {
  const head = [
    cell('Категория', true, 'left'),
    ...periods.map((key) => cell(periodLabel(key, period), true, 'right')),
    cell('Σ', true, 'right'),
  ].join('');

  const body = data.rows.map((row) => {
    const cells = periods.map((key) => {
      const value = row.byPeriod.get(key);
      // A dash reads as "nothing here" far faster than a column of $0
      return cell(value ? money(value) : '—', false, 'right');
    });
    const total = cell(money(windowTotal(row, periods)), false, 'right');
    return `<tr>${cell(row.category, false, 'left')}${cells.join('')}${total}</tr>`;
  });

  const sum = periods.reduce((acc, key) => acc + (data.totals.get(key) ?? 0), 0);
  const footer = `<tr>${cell('Итого', true, 'left')}${periods
    .map((key) => cell(money(data.totals.get(key) ?? 0), true, 'right'))
    .join('')}${cell(money(sum), true, 'right')}</tr>`;

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
      enc({ period: 'week', count: DEFAULT_REPORT.count }),
      state.period === 'week',
    ),
    richButton('Месяцы', enc({ period: 'month', count: 6 }), state.period === 'month'),
    richButton(state.oneOff ? '− разовые' : '+ разовые', enc({ oneOff: !state.oneOff }), false),
  ].join('');

  const counts = COUNT_CHOICES[state.period]
    .map((n) => richButton(String(n), enc({ count: n }), n === state.count))
    .join('');

  return `<tg-button-row>${periods}</tg-button-row><tg-button-row>${counts}</tg-button-row>`;
}

export function renderReportRich(state: ReportState, data: ReportData): string {
  const header = `<h3>📊 ${escapeRich(title(state))}</h3><p>${escapeRich(subtitle(state, data))}</p>`;

  if (data.rows.length === 0) {
    return `${header}<p>${escapeRich(EMPTY)}</p>${richControls(state, data)}`;
  }

  const tables = chunk(data.periods, MAX_TABLE_PERIODS)
    .map((slice) => richTable(data, slice, state.period))
    .join('');
  const note = oneOffNote(state, data);

  return [
    header,
    tables,
    `<details><summary>Динамика итогов</summary>${trendBars(data, state.period)}</details>`,
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
          return pad(value ? money(value) : '—', width, true);
        }),
      ].join(' '),
    ),
    [
      pad('Итого', NAME_WIDTH, false),
      ...data.periods.map((key) => pad(money(data.totals.get(key) ?? 0), width, true)),
    ].join(' '),
  ];

  const note = oneOffNote(state, data);
  return [
    header,
    `<pre>${escapeHtml(lines.join('\n'))}</pre>`,
    trendBars(data, state.period),
    note ? `<i>${escapeHtml(note)}</i>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

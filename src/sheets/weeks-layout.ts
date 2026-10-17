import type { sheets_v4 } from 'googleapis';
import { categoryLabel } from '../domain/category-labels.js';
import { TRANSFER_CATEGORY, type Category } from '../domain/reference.js';
import { OPERATIONS_SHEET } from './operations.js';
import { normalizeHeader } from './schema-check.js';

/**
 * Layout of the formula-only sheets «Недели» (the report: categories × 1–8 / 9–16 / 17–24 / 25–end
 * buckets of six months) and the hidden «_Недели» (one row per income/expense with the amount in the
 * chosen currency and its bucket). Everything here is pure: the script only feeds it the sheet's
 * headers and categories and sends what comes out. docs/SHEET_V2.md §8 describes the result.
 */

export const WEEKS_SHEET = 'Недели';
export const HELPER_SHEET = '_Недели';
export const RATES_SHEET = 'Курсы';

export const MONTHS = 6;
const BUCKETS = 4;
const MONTH_WIDTH = BUCKETS + 1; // four buckets and the month total
const NORM_MONTHS = 6;
const INCOME_CATEGORY = 'Income';
const INDENT = '    ';
const NUMBER_FORMAT = '#,##0;-#,##0;;@'; // zeros stay blank, as in the old «Сводка»
const OVERSPEND_RATIO = 1.3;
const ROW_PADDING = 10;
const MIN_HELPER_ROWS = 6000;

/** 0-based columns of «Недели»: A label, B trend, C norm, then six months of five columns. */
const COL = { label: 0, trend: 1, norm: 2, first: 3 } as const;
const LAST_COL = COL.first + MONTHS * MONTH_WIDTH - 1; // AG
const KEY_CATEGORY = LAST_COL + 1; // AH
const KEY_SUBCATEGORY = LAST_COL + 2; // AI
const KEY_KIND = LAST_COL + 3; // AJ
export const WEEKS_COLUMNS = KEY_KIND + 1;

/** 1-based rows of the fixed part of «Недели»; categories start at `firstCategory`. */
export const ROWS = {
  title: 1,
  currency: 2,
  oneOff: 3,
  firstMonth: 4,
  starts: 5,
  markers: 6,
  months: 7,
  header: 8,
  income: 9,
  expense: 10,
  savings: 11,
  firstCategory: 13,
} as const;

const HELPER_HEADERS = [
  'Дата',
  'Тип',
  'Категория',
  'Подкатегория',
  'Разовая',
  'USD',
  'RUB',
  'Сумма',
  'Неделя',
  'Месяц',
];
export const HELPER_COLUMNS = HELPER_HEADERS.length;

const MONTH_NAMES = [
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

type Request = sheets_v4.Schema$Request;
type GridRange = sheets_v4.Schema$GridRange;
type CellFormat = sheets_v4.Schema$CellFormat;

/** 0-based column index → letters (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
  let rest = index + 1;
  let letters = '';
  while (rest > 0) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

const L = columnLetter;
const monthStart = (month: number) => COL.first + month * MONTH_WIDTH;
const sigmaCol = (month: number) => monthStart(month) + BUCKETS;

// ───────────────────────── columns of «Операции» ─────────────────────────

const OPERATION_HEADERS = {
  date: 'Дата',
  type: 'Тип',
  amount: 'Сумма',
  category: 'Категория',
  subcategory: 'Подкатегория',
  oneOff: 'Разовая',
  currency: 'Валюта',
  usd: 'Сумма USD',
} as const;

/** Letters of the «Операции» columns the helper sheet reads. */
export type OperationColumns = Record<keyof typeof OPERATION_HEADERS, string>;

export type FindColumnsResult =
  | { ok: true; columns: OperationColumns }
  | { ok: false; missing: string[] };

/**
 * Finds the needed columns of «Операции» by header name, so the same code works before the
 * «Добавлено» migration (Валюта in L) and after it (Валюта in M).
 */
export function findColumns(header: unknown[]): FindColumnsResult {
  const normalized = header.map(normalizeHeader);
  const columns: Partial<OperationColumns> = {};
  const missing: string[] = [];

  for (const key of Object.keys(OPERATION_HEADERS) as (keyof OperationColumns)[]) {
    const title = OPERATION_HEADERS[key];
    const index = normalized.indexOf(normalizeHeader(title));
    if (index === -1) missing.push(title);
    else columns[key] = L(index);
  }
  return missing.length > 0
    ? { ok: false, missing }
    : { ok: true, columns: columns as OperationColumns };
}

// ───────────────────────────── formulas ──────────────────────────────

const helperRange = (letter: string) => `'${HELPER_SHEET}'!$${letter}:$${letter}`;
const HELPER = {
  type: helperRange('B'),
  category: helperRange('C'),
  subcategory: helperRange('D'),
  amount: helperRange('H'),
  week: helperRange('I'),
  month: helperRange('J'),
};
const WEEKS = `'${WEEKS_SHEET}'`;
const CATEGORY_KEY = `$${L(KEY_CATEGORY)}`;
const SUBCATEGORY_KEY = `$${L(KEY_SUBCATEGORY)}`;
const KIND_KEY = `$${L(KEY_KIND)}`;

/**
 * The single ARRAYFORMULA of «_Недели»!A2. Money in RUB is the USD amount at the day's USDRUB (the
 * same approximate VLOOKUP as «Операции»!Курс; before the history starts — the current rate), the
 * amount is chosen by «Недели»!B2, one-off expenses are zeroed unless «Недели»!B3 is ticked.
 */
export function helperFormula(columns: OperationColumns, rubRow: number): string {
  const op = (letter: string) => `'${OPERATIONS_SHEET}'!$${letter}$2:$${letter}`;
  const week = 'DATE(YEAR(dayInt),MONTH(dayInt),1+8*INT((DAY(dayInt)-1)/8))';
  const month = 'DATE(YEAR(dayInt),MONTH(dayInt),1)';
  return (
    '=ARRAYFORMULA(IFERROR(LET(' +
    [
      `dates,${op(columns.date)}`,
      `types,${op(columns.type)}`,
      `sums,${op(columns.amount)}`,
      `cats,${op(columns.category)}`,
      `subs,${op(columns.subcategory)}`,
      `once,${op(columns.oneOff)}`,
      `curs,${op(columns.currency)}`,
      `usds,${op(columns.usd)}`,
      'dayInt,INT(dates)',
      `rubs,IF(curs="RUB",sums,usds*IFERROR(VLOOKUP(dayInt,'${RATES_SHEET}'!$H$4:$I,2,TRUE),'${RATES_SHEET}'!$E$${rubRow}))`,
      'oneOff,(once=TRUE)*(types="Расход")',
      `amounts,IF(${WEEKS}!$B$${ROWS.currency}="RUB",rubs,usds)*(1-oneOff*NOT(${WEEKS}!$B$${ROWS.oneOff}))`,
      `FILTER(HSTACK(dayInt,types,cats,subs,once=TRUE,usds,rubs,amounts,${week},${month}),` +
        'ISNUMBER(dates)*((types="Расход")+(types="Доход"))*ISNUMBER(usds))',
    ].join(',') +
    '),""))'
  );
}

/** Text that USER_ENTERED could take for a number, date or formula gets a leading apostrophe. */
function asText(text: string): string {
  return /^[=+\-@'\d]|^(true|false)$/i.test(text.trim()) ? `'${text}` : text;
}

const firstMonthFormula =
  `=IF(ISNUMBER($B$${ROWS.firstMonth}),DATE(YEAR($B$${ROWS.firstMonth}),MONTH($B$${ROWS.firstMonth}),1),` +
  `EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-${MONTHS - 1}))`;

function bucketStartFormula(month: number, bucket: number): string {
  return `=DATE(YEAR($B$${ROWS.starts}),MONTH($B$${ROWS.starts})+${month},${1 + 8 * bucket})`;
}

function monthStartFormula(month: number): string {
  return `=DATE(YEAR($B$${ROWS.starts}),MONTH($B$${ROWS.starts})+${month},1)`;
}

function monthTitleFormula(letter: string): string {
  const start = `${letter}$${ROWS.starts}`;
  const current = `AND(YEAR(${start})=YEAR(TODAY()),MONTH(${start})=MONTH(TODAY()))`;
  return (
    `=CHOOSE(MONTH(${start}),${MONTH_NAMES.map((name) => `"${name}"`).join(',')})&" "&YEAR(${start})` +
    `&IF(${current}," (по "&TEXT(TODAY(),"dd.mm")&")","")`
  );
}

const lastBucketLabel = (letter: string) => `="25–"&DAY(EOMONTH(${letter}$${ROWS.starts},0))`;

const BUCKET_LABELS = ['1–8', '9–16', '17–24'];

/** SUMIFS of the helper's amount in the bucket of column `letter`; `extra` adds criteria pairs. */
function bucketSum(letter: string, type: string, extra = ''): string {
  return (
    `=SUMIFS(${HELPER.amount},${HELPER.week},${letter}$${ROWS.starts},` +
    `${HELPER.type},"${type}"${extra})`
  );
}

const categoryCriteria = (row: number) => `,${HELPER.category},${CATEGORY_KEY}${row}`;
const subcategoryCriteria = (row: number) =>
  `${categoryCriteria(row)},${HELPER.subcategory},${SUBCATEGORY_KEY}${row}`;

function trendFormula(row: number, kind: RowKind): string {
  const cells = `$${L(COL.first)}${row}:$${L(LAST_COL)}${row}`;
  const markers = `$${L(COL.first)}$${ROWS.markers}:$${L(LAST_COL)}$${ROWS.markers}`;
  const color = kind === 'in' ? '#2f9e44' : kind === 'sav' ? '#1c7ed6' : '#e8590c';
  // Savings can be negative, so its columns don't start from zero
  const floor = kind === 'sav' ? '' : '"ymin",0;';
  return `=SPARKLINE(FILTER(${cells},${markers}="w"),{"charttype","column";${floor}"color","${color}"})`;
}

/** Month sum of the last `NORM_MONTHS` full months; `extra` adds criteria pairs to the SUMIFS. */
function normMonthSum(extra = ''): string {
  return (
    `SUMIFS(${HELPER.amount},${HELPER.month},EDATE(monthStart,-back),` +
    `${HELPER.type},"Расход"${extra})`
  );
}

function normFormula(expression: string): string {
  return (
    '=LET(monthStart,DATE(YEAR(TODAY()),MONTH(TODAY()),1),' +
    `MEDIAN(MAP(SEQUENCE(${NORM_MONTHS}),LAMBDA(back,${expression}))))`
  );
}

/** «Норма/мес»: median of the last 6 full months, whatever window is shown. */
function normFor(row: WeeksRow): string {
  switch (row.kind) {
    case 'out':
      return normFormula(normMonthSum());
    case 'cat':
      return normFormula(normMonthSum(categoryCriteria(row.row)));
    case 'sub':
      return normFormula(normMonthSum(subcategoryCriteria(row.row)));
    case 'rest': {
      // The category less each listed subcategory, month by month
      const group = row.group;
      const subs = group ? rowsBetween(group.first, group.last - 1) : [];
      const minus = subs.map((sub) => `-${normMonthSum(subcategoryCriteria(sub))}`).join('');
      // Rounded like the remainder in the grid: a float crumb would print as «-0»
      return normFormula(`ROUND(${normMonthSum(categoryCriteria(row.row))}${minus},2)`);
    }
    default:
      return '';
  }
}

function rowsBetween(first: number, last: number): number[] {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}

// ───────────────────────────── row plan ──────────────────────────────

export type RowKind = 'in' | 'out' | 'sav' | 'cat' | 'sub' | 'rest' | 'ctl';

export interface WeeksGroup {
  category: string;
  /** 1-based row of the category itself. */
  header: number;
  /** 1-based, inclusive: its subcategories and the remainder row (the last one). */
  first: number;
  last: number;
}

export interface WeeksRow {
  kind: RowKind;
  /** 1-based row of «Недели». */
  row: number;
  label: string;
  /** Key in «Categories» (cat, sub, rest). */
  category: string;
  /** Key in «Categories» (sub only). */
  subcategory: string;
  /** Collapsible block of the category (sub, rest). */
  group: WeeksGroup | null;
}

/** Top-level categories whose spending the sheet shows: everything except income and transfers. */
export function expenseCategories(categories: Category[]): Category[] {
  return categories.filter((c) => c.name !== INCOME_CATEGORY && c.name !== TRANSFER_CATEGORY);
}

interface RowPlan {
  rows: WeeksRow[];
  groups: WeeksGroup[];
  /** Last row of the category blocks. */
  categoriesEnd: number;
  /** The «Контроль: вне категорий» row, which is also the last one. */
  control: number;
  lastRow: number;
}

function fixedRow(kind: RowKind, row: number, label: string): WeeksRow {
  return { kind, row, label, category: '', subcategory: '', group: null };
}

function planRows(categories: Category[]): RowPlan {
  const expense = expenseCategories(categories);
  if (expense.length === 0) throw new Error('В «Categories» нет категорий расходов');

  const rows: WeeksRow[] = [
    fixedRow('in', ROWS.income, 'Доходы итого'),
    fixedRow('out', ROWS.expense, 'Расходы итого'),
    fixedRow('sav', ROWS.savings, 'Сбережения'),
  ];
  const groups: WeeksGroup[] = [];
  let row = ROWS.firstCategory;

  for (const { name, subcategories } of expense) {
    const header = row++;
    const group: WeeksGroup | null =
      subcategories.length > 0
        ? { category: name, header, first: header + 1, last: header + subcategories.length + 1 }
        : null;
    rows.push({
      kind: 'cat',
      row: header,
      label: categoryLabel(name),
      category: name,
      subcategory: '',
      group: null,
    });
    for (const subcategory of subcategories) {
      rows.push({
        kind: 'sub',
        row: row++,
        label: INDENT + subcategory,
        category: name,
        subcategory,
        group,
      });
    }
    if (group) {
      rows.push({
        kind: 'rest',
        row: row++,
        label: `${INDENT}без подкатегории / прочее`,
        category: name,
        subcategory: '',
        group,
      });
      groups.push(group);
    }
  }

  const categoriesEnd = row - 1;
  const control = row + 1; // one blank row above, as below the totals
  rows.push(fixedRow('ctl', control, 'Контроль: вне категорий'));
  return { rows, groups, categoriesEnd, control, lastRow: control };
}

// ───────────────────────────── cell values ───────────────────────────

export interface SheetValues {
  range: string;
  values: unknown[][];
}

export interface WeeksLayout extends RowPlan {
  columns: OperationColumns;
  rubRow: number;
  /** Contents of «_Недели»: headers and the ARRAYFORMULA. */
  helper: SheetValues;
  /** Contents of «Недели» from A1 to AJ<lastRow>: labels, formulas and the control cells. */
  weeks: SheetValues;
}

function helperValues(columns: OperationColumns, rubRow: number): SheetValues {
  const formula = helperFormula(columns, rubRow);
  return {
    range: `'${HELPER_SHEET}'!A1:${L(HELPER_COLUMNS - 1)}2`,
    values: [HELPER_HEADERS, [formula, ...Array<string>(HELPER_COLUMNS - 1).fill('')]],
  };
}

function statusFormula(control: number): string {
  const cells = `$${L(COL.first)}$${control}:$${L(LAST_COL)}$${control}`;
  return `=IFERROR(IF(SUMPRODUCT(ABS(${cells}))=0,"✓ сходится","⚠ есть траты вне категорий"),"⚠ ошибка расчёта")`;
}

/** Formula of one grid cell: `letter` is its column, `bucket` 0–3 or 4 for the month total. */
function gridFormula(row: WeeksRow, plan: RowPlan, month: number, bucket: number): string {
  const letter = L(monthStart(month) + bucket);
  const r = row.row;
  if (row.kind === 'ctl') {
    const kinds = `${KIND_KEY}$${ROWS.firstCategory}:${KIND_KEY}$${plan.categoriesEnd}`;
    const cells = `${letter}$${ROWS.firstCategory}:${letter}$${plan.categoriesEnd}`;
    return `=ROUND(${letter}${ROWS.expense}-SUMIF(${kinds},"cat",${cells}),2)`;
  }
  if (bucket === BUCKETS) {
    return `=SUM(${L(monthStart(month))}${r}:${L(monthStart(month) + BUCKETS - 1)}${r})`;
  }

  switch (row.kind) {
    case 'in':
      return bucketSum(letter, 'Доход');
    case 'out':
      return bucketSum(letter, 'Расход');
    case 'sav':
      return `=${letter}${ROWS.income}-${letter}${ROWS.expense}`;
    case 'cat':
      return bucketSum(letter, 'Расход', categoryCriteria(r));
    case 'sub':
      return bucketSum(letter, 'Расход', subcategoryCriteria(r));
    default: {
      // A subcategory missing from the sheet lands here, so the category total never breaks
      const group = row.group;
      if (!group) return '';
      return `=ROUND(${letter}${group.header}-SUM(${letter}${group.first}:${letter}${group.last - 1}),2)`;
    }
  }
}

function weeksValues(plan: RowPlan): SheetValues {
  const grid = Array.from({ length: plan.lastRow }, () => Array<unknown>(WEEKS_COLUMNS).fill(''));
  const put = (row: number, col: number, value: unknown) => {
    const line = grid[row - 1];
    if (line) line[col] = value;
  };

  put(ROWS.title, COL.label, 'Траты по неделям');
  put(ROWS.title, COL.norm, statusFormula(plan.control));
  put(ROWS.currency, COL.label, 'Валюта');
  put(ROWS.currency, COL.trend, 'USD');
  put(ROWS.oneOff, COL.label, 'С разовыми');
  put(ROWS.oneOff, COL.trend, false);
  put(ROWS.firstMonth, COL.label, 'Первый месяц');
  put(ROWS.firstMonth, COL.norm, 'пусто — последние 6 месяцев');
  put(ROWS.starts, COL.trend, firstMonthFormula);
  put(ROWS.header, COL.label, `="Категория, "&$B$${ROWS.currency}`);
  put(ROWS.header, COL.trend, 'Тренд');
  put(ROWS.header, COL.norm, 'Норма/мес');

  for (let month = 0; month < MONTHS; month++) {
    put(ROWS.months, monthStart(month), monthTitleFormula(L(monthStart(month))));
    for (let bucket = 0; bucket <= BUCKETS; bucket++) {
      const col = monthStart(month) + bucket;
      const isTotal = bucket === BUCKETS;
      put(ROWS.starts, col, isTotal ? monthStartFormula(month) : bucketStartFormula(month, bucket));
      put(ROWS.markers, col, isTotal ? 'm' : 'w');
      put(ROWS.header, col, isTotal ? 'Σ' : (BUCKET_LABELS[bucket] ?? lastBucketLabel(L(col))));
    }
  }

  for (const row of plan.rows) {
    put(row.row, COL.label, asText(row.label));
    if (row.kind !== 'ctl') put(row.row, COL.trend, trendFormula(row.row, row.kind));
    const norm = normFor(row);
    if (norm) put(row.row, COL.norm, norm);
    if (row.category) put(row.row, KEY_CATEGORY, asText(row.category));
    if (row.subcategory) put(row.row, KEY_SUBCATEGORY, asText(row.subcategory));
    put(row.row, KEY_KIND, row.kind);

    for (let month = 0; month < MONTHS; month++) {
      for (let bucket = 0; bucket <= BUCKETS; bucket++) {
        put(row.row, monthStart(month) + bucket, gridFormula(row, plan, month, bucket));
      }
    }
  }

  return { range: `'${WEEKS_SHEET}'!A1:${L(WEEKS_COLUMNS - 1)}${plan.lastRow}`, values: grid };
}

export interface WeeksInput {
  /** Parsed «Categories» — income and transfers are skipped here. */
  categories: Category[];
  columns: OperationColumns;
  /** 1-based row of RUB in «Курсы» (column E holds its current rate). */
  rubRow: number;
}

export function buildWeeksLayout({ categories, columns, rubRow }: WeeksInput): WeeksLayout {
  const plan = planRows(categories);
  return {
    ...plan,
    columns,
    rubRow,
    helper: helperValues(columns, rubRow),
    weeks: weeksValues(plan),
  };
}

/** Rows of the helper sheet: room for twice the rows of «Операции», never fewer than 6000. */
export function helperRowCount(operationsRows: number): number {
  return Math.max(MIN_HELPER_ROWS, 2 * operationsRows);
}

/** One formula of each kind, to eyeball in a dry run: `[what, cell, formula]`. */
export function sampleFormulas(layout: WeeksLayout): [string, string, string][] {
  const { values } = layout.weeks;
  const cellOf = (row: number, col: number): [string, string] => [
    `${L(col)}${row}`,
    String(values[row - 1]?.[col] ?? ''),
  ];
  const first = (kind: RowKind) => layout.rows.find((r) => r.kind === kind);
  const picks: [string, number | undefined, number][] = [
    ['статус', ROWS.title, COL.norm],
    ['первый месяц', ROWS.starts, COL.trend],
    ['начало недели', ROWS.starts, COL.first],
    ['название месяца', ROWS.months, COL.first],
    ['доходы', ROWS.income, COL.first],
    ['расходы', ROWS.expense, COL.first],
    ['сбережения', ROWS.savings, COL.first],
    ['категория', first('cat')?.row, COL.first],
    ['подкатегория', first('sub')?.row, COL.first],
    ['остаток', first('rest')?.row, COL.first],
    ['Σ месяца', first('cat')?.row, sigmaCol(0)],
    ['тренд', first('cat')?.row, COL.trend],
    ['норма категории', first('cat')?.row, COL.norm],
    ['норма подкатегории', first('sub')?.row, COL.norm],
    ['норма остатка', first('rest')?.row, COL.norm],
    ['контроль', layout.control, COL.first],
  ];
  return [
    ['помощник', `'${HELPER_SHEET}'!A2`, String(layout.helper.values[1]?.[0] ?? '')],
    ...picks.flatMap(([what, row, col]): [string, string, string][] => {
      if (row === undefined) return [];
      const [cell, formula] = cellOf(row, col);
      return [[what, cell, formula]];
    }),
  ];
}

// ───────────────────────────── formatting ────────────────────────────

const COLORS = {
  white: '#ffffff',
  header: '#e9ecef',
  total: '#f1f3f5',
  input: '#fff3bf',
  muted: '#868e96',
  income: '#69db7c',
  expense: '#ff922b',
  expenseLight: '#ffd8a8',
  loss: '#ff8787',
  alarm: '#ffa8a8',
  warning: '#e03131',
};

function rgb(hex: string): sheets_v4.Schema$Color {
  const channel = (from: number) => parseInt(hex.slice(from, from + 2), 16) / 255;
  return { red: channel(1), green: channel(3), blue: channel(5) };
}

/** GridRange from 1-based inclusive rows and 0-based inclusive columns. */
function cells(
  sheetId: number,
  firstRow: number,
  lastRow: number,
  firstCol: number,
  lastCol: number,
): GridRange {
  return {
    sheetId,
    startRowIndex: firstRow - 1,
    endRowIndex: lastRow,
    startColumnIndex: firstCol,
    endColumnIndex: lastCol + 1,
  };
}

function repeat(range: GridRange, format: CellFormat, fields: string[]): Request {
  return {
    repeatCell: {
      range,
      cell: { userEnteredFormat: format },
      fields: fields.map((field) => `userEnteredFormat.${field}`).join(','),
    },
  };
}

function dimension(
  sheetId: number,
  kind: 'ROWS' | 'COLUMNS',
  start: number,
  end: number,
  properties: sheets_v4.Schema$DimensionProperties,
  fields: string,
): Request {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: kind, startIndex: start, endIndex: end },
      properties,
      fields,
    },
  };
}

const eachMonth = <T>(build: (month: number) => T): T[] =>
  Array.from({ length: MONTHS }, (_, month) => build(month));

function sizeRequests(sheetId: number): Request[] {
  const width = (start: number, end: number, pixelSize: number) =>
    dimension(sheetId, 'COLUMNS', start, end, { pixelSize }, 'pixelSize');
  return [
    width(COL.label, COL.label + 1, 210),
    width(COL.trend, COL.trend + 1, 100),
    width(COL.norm, COL.norm + 1, 90),
    width(COL.first, LAST_COL + 1, 64),
    ...eachMonth((month) => width(sigmaCol(month), sigmaCol(month) + 1, 80)),
    dimension(
      sheetId,
      'COLUMNS',
      KEY_CATEGORY,
      KEY_KIND + 1,
      { hiddenByUser: true },
      'hiddenByUser',
    ),
    dimension(
      sheetId,
      'ROWS',
      ROWS.starts - 1,
      ROWS.markers,
      { hiddenByUser: true },
      'hiddenByUser',
    ),
  ];
}

function styleRequests(layout: WeeksLayout, sheetId: number): Request[] {
  const { control, lastRow } = layout;
  const bold: CellFormat = { textFormat: { bold: true } };
  const muted: CellFormat = { textFormat: { foregroundColor: rgb(COLORS.muted) } };
  const background = (color: string): CellFormat => ({ backgroundColor: rgb(color) });
  const border = { style: 'SOLID', color: rgb(COLORS.muted) };

  return [
    repeat(
      cells(sheetId, ROWS.income, lastRow, COL.norm, LAST_COL),
      { numberFormat: { type: 'NUMBER', pattern: NUMBER_FORMAT } },
      ['numberFormat'],
    ),
    repeat(
      cells(sheetId, ROWS.title, ROWS.title, COL.label, COL.label),
      { textFormat: { bold: true, fontSize: 14 } },
      ['textFormat.bold', 'textFormat.fontSize'],
    ),
    repeat(cells(sheetId, ROWS.title, ROWS.title, COL.norm, COL.norm), bold, ['textFormat.bold']),
    repeat(
      cells(sheetId, ROWS.currency, ROWS.firstMonth, COL.trend, COL.trend),
      background(COLORS.input),
      ['backgroundColor'],
    ),
    repeat(
      cells(sheetId, ROWS.currency, ROWS.firstMonth, COL.trend, COL.trend),
      { horizontalAlignment: 'CENTER' },
      ['horizontalAlignment'],
    ),
    repeat(
      cells(sheetId, ROWS.firstMonth, ROWS.firstMonth, COL.norm, COL.norm),
      { textFormat: { italic: true, foregroundColor: rgb(COLORS.muted) } },
      ['textFormat.italic', 'textFormat.foregroundColor'],
    ),
    // Month and column headers
    repeat(
      cells(sheetId, ROWS.months, ROWS.header, COL.label, LAST_COL),
      background(COLORS.header),
      ['backgroundColor'],
    ),
    repeat(cells(sheetId, ROWS.months, ROWS.header, COL.label, LAST_COL), bold, [
      'textFormat.bold',
    ]),
    repeat(
      cells(sheetId, ROWS.months, ROWS.header, COL.trend, LAST_COL),
      { horizontalAlignment: 'CENTER' },
      ['horizontalAlignment'],
    ),
    // Norms are context, not data
    repeat(cells(sheetId, ROWS.income, lastRow, COL.norm, COL.norm), muted, [
      'textFormat.foregroundColor',
    ]),
    repeat(cells(sheetId, ROWS.income, ROWS.savings, COL.label, LAST_COL), bold, [
      'textFormat.bold',
    ]),
    ...layout.rows
      .filter((row) => row.kind === 'cat')
      .map((row) =>
        repeat(cells(sheetId, row.row, row.row, COL.label, LAST_COL), bold, ['textFormat.bold']),
      ),
    repeat(
      cells(sheetId, control, control, COL.label, LAST_COL),
      { textFormat: { italic: true, foregroundColor: rgb(COLORS.muted) } },
      ['textFormat.italic', 'textFormat.foregroundColor'],
    ),
    // Month totals in grey, a line before each month
    ...eachMonth((month) =>
      repeat(
        cells(sheetId, ROWS.income, lastRow, sigmaCol(month), sigmaCol(month)),
        background(COLORS.total),
        ['backgroundColor'],
      ),
    ),
    ...eachMonth(
      (month): Request => ({
        updateBorders: {
          range: cells(sheetId, ROWS.months, lastRow, monthStart(month), monthStart(month)),
          left: border,
        },
      }),
    ),
    ...eachMonth(
      (month): Request => ({
        mergeCells: {
          range: cells(sheetId, ROWS.months, ROWS.months, monthStart(month), sigmaCol(month)),
          mergeType: 'MERGE_ALL',
        },
      }),
    ),
  ];
}

function validationRequests(sheetId: number): Request[] {
  const single = (row: number) => cells(sheetId, row, row, COL.trend, COL.trend);
  return [
    {
      setDataValidation: {
        range: single(ROWS.currency),
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [{ userEnteredValue: 'USD' }, { userEnteredValue: 'RUB' }],
          },
          strict: true,
          showCustomUi: true,
        },
      },
    },
    {
      setDataValidation: {
        range: single(ROWS.oneOff),
        rule: { condition: { type: 'BOOLEAN' } },
      },
    },
    {
      setDataValidation: {
        range: single(ROWS.firstMonth),
        rule: {
          condition: { type: 'DATE_IS_VALID' },
          inputMessage: 'Пусто — последние 6 месяцев',
          strict: true,
        },
      },
    },
  ];
}

function conditionalRequests(layout: WeeksLayout, sheetId: number): Request[] {
  const rules: sheets_v4.Schema$ConditionalFormatRule[] = [];

  // A month above its norm by 30%: the total is red
  const overspend = (letter: string) =>
    `=AND(ISNUMBER($${L(COL.norm)}${ROWS.expense}),$${L(COL.norm)}${ROWS.expense}>0,` +
    `${letter}${ROWS.expense}>${OVERSPEND_RATIO}*$${L(COL.norm)}${ROWS.expense})`;
  for (let month = 0; month < MONTHS; month++) {
    const col = sigmaCol(month);
    rules.push({
      ranges: [cells(sheetId, ROWS.expense, layout.categoriesEnd, col, col)],
      booleanRule: {
        condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: overspend(L(col)) }] },
        format: { backgroundColor: rgb(COLORS.alarm) },
      },
    });
  }

  const controlFirst = `${L(COL.first)}${layout.control}`;
  rules.push({
    ranges: [cells(sheetId, layout.control, layout.control, COL.first, LAST_COL)],
    booleanRule: {
      condition: {
        type: 'CUSTOM_FORMULA',
        values: [{ userEnteredValue: `=AND(ISNUMBER(${controlFirst}),${controlFirst}<>0)` }],
      },
      format: { backgroundColor: rgb(COLORS.alarm) },
    },
  });
  rules.push({
    ranges: [cells(sheetId, ROWS.title, ROWS.title, COL.norm, COL.norm)],
    booleanRule: {
      condition: {
        type: 'CUSTOM_FORMULA',
        values: [{ userEnteredValue: `=LEFT($${L(COL.norm)}$${ROWS.title},1)<>"✓"` }],
      },
      format: { textFormat: { foregroundColor: rgb(COLORS.warning), bold: true } },
    },
  });

  // Each row is colored against its own maximum; categories stronger than their subcategories
  const point = (
    type: string,
    color: string,
    value?: string,
  ): sheets_v4.Schema$InterpolationPoint => ({
    type,
    color: rgb(color),
    ...(value === undefined ? {} : { value }),
  });
  const weekMarkers = `$${L(COL.first)}$${ROWS.markers}:$${L(LAST_COL)}$${ROWS.markers},"w"`;
  for (const row of layout.rows) {
    if (row.kind === 'ctl') continue;
    const ranges = eachMonth((month) =>
      cells(sheetId, row.row, row.row, monthStart(month), monthStart(month) + BUCKETS - 1),
    );
    const strong = row.kind === 'out' || row.kind === 'cat';
    const gradientRule: sheets_v4.Schema$GradientRule =
      row.kind === 'sav'
        ? {
            minpoint: point('MIN', COLORS.loss),
            midpoint: point('NUMBER', COLORS.white, '0'),
            maxpoint: point('MAX', COLORS.income),
          }
        : {
            minpoint: point('NUMBER', COLORS.white, '0'),
            // Not plain MAX: a row of zeros has min = max = 0, and Sheets paints all of it full color
            maxpoint: point(
              'NUMBER',
              row.kind === 'in' ? COLORS.income : strong ? COLORS.expense : COLORS.expenseLight,
              `=MAX(1,MAXIFS($${L(COL.first)}$${row.row}:$${L(LAST_COL)}$${row.row},${weekMarkers}))`,
            ),
          };
    rules.push({ ranges, gradientRule });
  }

  return rules.map((rule, index) => ({ addConditionalFormatRule: { rule, index } }));
}

function groupRequests(layout: WeeksLayout, sheetId: number): Request[] {
  const range = (group: WeeksGroup): sheets_v4.Schema$DimensionRange => ({
    sheetId,
    dimension: 'ROWS',
    startIndex: group.first - 1,
    endIndex: group.last,
  });
  return [
    ...layout.groups.map((group): Request => ({ addDimensionGroup: { range: range(group) } })),
    ...layout.groups.map(
      (group): Request => ({
        updateDimensionGroup: {
          dimensionGroup: { range: range(group), depth: 1, collapsed: true },
          fields: 'collapsed',
        },
      }),
    ),
  ];
}

// Only the helper: a protected grid on «Недели» asks «Heads up!» on every group toggle
function protectionRequests(ids: WeeksSheetIds): Request[] {
  return [
    {
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: ids.helper },
          description: 'Служебный лист «Недели»: одна формула в A2',
          warningOnly: true,
        },
      },
    },
  ];
}

export interface WeeksSheetIds {
  weeks: number;
  helper: number;
}

/** Creates both sheets: the helper hidden and last, «Недели» frozen and with group toggles on top. */
export function addSheetRequests(
  layout: WeeksLayout,
  options: { helperRows: number; weeksIndex?: number },
): Request[] {
  return [
    {
      addSheet: {
        properties: {
          title: HELPER_SHEET,
          hidden: true,
          gridProperties: { rowCount: options.helperRows, columnCount: HELPER_COLUMNS },
        },
      },
    },
    {
      addSheet: {
        properties: {
          title: WEEKS_SHEET,
          index: options.weeksIndex,
          gridProperties: {
            rowCount: layout.lastRow + ROW_PADDING,
            columnCount: WEEKS_COLUMNS,
            frozenRowCount: ROWS.header,
            frozenColumnCount: COL.first,
            rowGroupControlAfter: false,
          },
        },
      },
    },
  ];
}

/** Everything that styles «Недели» once the values are in; no values are touched. */
export function weeksRequests(layout: WeeksLayout, ids: WeeksSheetIds): Request[] {
  return [
    ...sizeRequests(ids.weeks),
    ...styleRequests(layout, ids.weeks),
    ...validationRequests(ids.weeks),
    ...conditionalRequests(layout, ids.weeks),
    ...groupRequests(layout, ids.weeks),
    ...protectionRequests(ids),
  ];
}

// ───────────────────────────── verification ──────────────────────────

const ERROR_VALUE = /^(#[A-Z/0!?]+|Err:.*|Loading\.{3})$/;
const TOTAL_TOLERANCE = 0.01;
const MONTHLY_SHEET = 'Категории по месяцам';
const MONTHLY_TOTAL_LABEL = 'Регулярные расходы, итого';

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function errorCells(sheet: string, grid: unknown[][]): string[] {
  const found: string[] = [];
  grid.forEach((line, r) =>
    line.forEach((value, c) => {
      if (typeof value === 'string' && ERROR_VALUE.test(value)) {
        found.push(`«${sheet}»!${L(c)}${r + 1}: ${value}`);
      }
    }),
  );
  return found;
}

/** Row index (0-based) of the row of `weeks` that the hidden AJ column marks with `kind`. */
function rowOfKind(weeks: unknown[][], kind: RowKind): number {
  return weeks.findIndex((line) => text(line[KEY_KIND]) === kind);
}

/** «Категория/Подкатегория» of «Categories» that «Недели» has no row for (they land in «прочее»). */
export function uncoveredSubcategories(categories: Category[], weeks: unknown[][]): string[] {
  const keys = (kind: RowKind) =>
    weeks
      .filter((line) => text(line[KEY_KIND]) === kind)
      .map((line) => [text(line[KEY_CATEGORY]), text(line[KEY_SUBCATEGORY])]);
  const shownCategories = new Set(keys('cat').map(([category]) => category));
  const shownSubs = new Set(keys('sub').map(([category, sub]) => `${category}/${sub}`));

  return expenseCategories(categories).flatMap(({ name, subcategories }) =>
    shownCategories.has(name)
      ? subcategories
          .filter((sub) => !shownSubs.has(`${name}/${sub}`))
          .map((sub) => `${name} / ${sub}`)
      : [`${name} (вся категория)`],
  );
}

/** «Расходы итого» of each month's Σ column of «Недели», by the month's first day. */
function weeksMonthTotals(weeks: unknown[][]): Map<number, number> {
  const totals = new Map<number, number>();
  const row = weeks[rowOfKind(weeks, 'out')] ?? [];
  const markers = weeks[ROWS.markers - 1] ?? [];
  const starts = weeks[ROWS.starts - 1] ?? [];
  markers.forEach((marker, col) => {
    const month = starts[col];
    const total = row[col];
    if (marker === 'm' && typeof month === 'number' && typeof total === 'number') {
      totals.set(month, total);
    }
  });
  return totals;
}

/** «Регулярные расходы, итого» of 'Категории по месяцам' by month; its month headers are dates. */
function monthlyTotals(monthly: unknown[][]): Map<number, number> {
  const totals = new Map<number, number>();
  const header = monthly.find((line) => text(line[0]) === 'Категория') ?? [];
  const row = monthly.find((line) => text(line[0]) === MONTHLY_TOTAL_LABEL) ?? [];
  header.forEach((month, col) => {
    const total = row[col];
    if (typeof month === 'number' && typeof total === 'number') totals.set(month, total);
  });
  return totals;
}

export interface WeeksCheckInput {
  /** «Недели»!A1:AJ as UNFORMATTED_VALUE. */
  weeks: unknown[][];
  /** «_Недели»!A1:J as UNFORMATTED_VALUE. */
  helper: unknown[][];
  /** 'Категории по месяцам'!A1:AD as UNFORMATTED_VALUE, if the sheet exists. */
  monthly: unknown[][] | null;
  categories: Category[];
}

export interface WeeksCheck {
  /** Things that must be fixed; a recalculation still going on shows up here too. */
  problems: string[];
  /** Things worth knowing that a recalculation doesn't change. */
  notes: string[];
}

const preview = (items: string[]) =>
  items.length > 5
    ? `${items.slice(0, 5).join('; ')}; … (всего ${items.length})`
    : items.join('; ');

/**
 * Checks the finished sheets: no error values, the helper has rows, the control row is zero and —
 * in USD without one-offs — «Расходы итого» per month equals «Регулярные расходы, итого» of
 * 'Категории по месяцам'.
 */
export function checkWeeks({ weeks, helper, monthly, categories }: WeeksCheckInput): WeeksCheck {
  const problems: string[] = [];
  const notes: string[] = [];

  const errors = [...errorCells(WEEKS_SHEET, weeks), ...errorCells(HELPER_SHEET, helper)];
  if (errors.length > 0) problems.push(`Ошибки в ячейках: ${preview(errors)}`);

  if (typeof helper[1]?.[0] !== 'number') {
    problems.push(`«${HELPER_SHEET}»!A2 не вернула строк (формула ещё считается или упала)`);
  }

  const control = weeks[rowOfKind(weeks, 'ctl')];
  if (!control) {
    problems.push('Нет строки контроля');
  } else {
    const off = Array.from({ length: LAST_COL - COL.first + 1 }, (_, i) => COL.first + i).flatMap(
      (col) => (control[col] === 0 ? [] : [`${L(col)}=${text(control[col]) || 'пусто'}`]),
    );
    if (off.length > 0) problems.push(`Контроль не нулевой: ${preview(off)}`);
  }
  const status = text(weeks[ROWS.title - 1]?.[COL.norm]);
  if (!status.startsWith('✓')) problems.push(`Статус «${status || 'пусто'}»`);

  const usdWithoutOneOffs =
    weeks[ROWS.currency - 1]?.[COL.trend] === 'USD' &&
    weeks[ROWS.oneOff - 1]?.[COL.trend] === false;
  if (!monthly) {
    notes.push(`Нет листа «${MONTHLY_SHEET}» — суммы не с чем сравнить`);
  } else if (!usdWithoutOneOffs) {
    notes.push('Сверка с «Категории по месяцам» только в USD без разовых (B2 = USD, B3 выключен)');
  } else {
    const ours = weeksMonthTotals(weeks);
    const theirs = monthlyTotals(monthly);
    const common = [...ours.keys()].filter((month) => theirs.has(month));
    const different = common.flatMap((month) => {
      const a = ours.get(month) ?? NaN;
      const b = theirs.get(month) ?? NaN;
      return Math.abs(a - b) <= TOTAL_TOLERANCE ? [] : [`${month}: ${a} ≠ ${b}`];
    });
    if (common.length === 0) notes.push('Нет общих месяцев с «Категории по месяцам»');
    else
      notes.push(
        `Расходы итого совпадают с «${MONTHLY_SHEET}» за ${common.length - different.length} из ${common.length} мес.`,
      );
    if (different.length > 0) {
      problems.push(
        `«Расходы итого» ≠ «${MONTHLY_SHEET}» (серийный номер месяца): ${preview(different)}`,
      );
    }
  }

  const uncovered = uncoveredSubcategories(categories, weeks);
  if (uncovered.length > 0) {
    notes.push(
      `В «Categories» есть то, чего нет на листе (суммы идут в «прочее», пересоздай с --replace): ${preview(uncovered)}`,
    );
  }
  return { problems, notes };
}

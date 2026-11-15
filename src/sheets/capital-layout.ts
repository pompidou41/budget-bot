import { HISTORY_ACCOUNT } from '../domain/reference.js';
import { OPERATIONS_SHEET } from './operations.js';
import { normalizeHeader } from './schema-check.js';
import { columnLetter as L, RATES_SHEET } from './weeks-layout.js';

export const CAPITAL_SHEET = 'Капитал';
export const ACCOUNTS_SHEET = 'Счета';
/** 31.12.9999: the cutoff of the «сейчас» row — every operation counts, as in «Счета»!J. */
export const NOW_CUTOFF = 2958465;
export const POINT_DAYS = [1, 9, 17, 25];
export const STEPS = ['Недели', 'Месяцы'] as const;
export type Step = (typeof STEPS)[number];
export const ARCHIVED = 'Архив';
export const CLOSED_GROUP = 'Закрытые';
export const SAVINGS_GROUPS = ['Подушка', 'Накопления', 'Инвестиции', 'Крипта'];
export const GROUP_COLUMNS = [
  'Текущие',
  'Ежемесячные',
  'Подушка',
  'Накопления',
  'Инвестиции',
  'Крипта',
  'Кредиты',
  CLOSED_GROUP,
];
/** Width of the hidden balance matrix: one column per account. */
export const MAX_ACCOUNTS = 60;

export const ROWS = {
  title: 1,
  currency: 2,
  step: 3,
  summaryHeader: 4,
  capital: 5,
  savings: 6,
  chart: 8,
  header: 24,
  first: 25,
} as const;

/** Hidden column N: rate, point count, the weekly point a month ago, start; cutoffs from `first`. */
export const HELPER_ROWS = { rate: 2, count: 3, monthAgo: 4, start: 5 } as const;
/** Hidden rows above the matrix: account ID, group, opening balance, «Дата начала», USD factor. */
export const META_ROWS = { id: 2, group: 3, opening: 4, since: 5, factor: 6 } as const;
/** Hidden row of USD balances at the «month ago» point: the summary is independent of the step. */
export const MONTH_AGO_ROW = 7;

export const COL = {
  label: 0,
  capital: 1,
  capitalDelta: 2,
  savings: 3,
  savingsDelta: 4,
  firstGroup: 5,
  helper: 13,
  matrix: 15,
} as const;
export const LAST_VISIBLE = COL.firstGroup + GROUP_COLUMNS.length - 1;
export const CAPITAL_COLUMNS = COL.matrix + MAX_ACCOUNTS;
export const CAPITAL_ROW_COUNT = 1000;

const OPERATION_HEADERS = {
  date: 'Дата',
  type: 'Тип',
  account: 'Счёт',
  amount: 'Сумма',
  toAccount: 'Счёт куда',
  received: 'Получено (расч.)',
} as const;

const ACCOUNT_HEADERS = {
  id: 'ID',
  type: 'Тип',
  currency: 'Валюта',
  group: 'Группа',
  inCapital: 'В капитале',
  opening: 'Начальный остаток',
  since: 'Дата начала',
  usd: 'Остаток USD',
} as const;

export type OperationIndexes = Record<keyof typeof OPERATION_HEADERS, number>;
export type AccountIndexes = Record<keyof typeof ACCOUNT_HEADERS, number>;
export type Found<T> = { ok: true; indexes: T } | { ok: false; missing: string[] };

function indexesOf<K extends string>(titles: Record<K, string>, header: unknown[]) {
  const normalized = header.map(normalizeHeader);
  const indexes = {} as Record<K, number>;
  const missing: string[] = [];
  for (const key of Object.keys(titles) as K[]) {
    const index = normalized.indexOf(normalizeHeader(titles[key]));
    if (index === -1) missing.push(titles[key]);
    else indexes[key] = index;
  }
  return missing.length > 0 ? ({ ok: false, missing } as const) : ({ ok: true, indexes } as const);
}

/** Columns found by header name: the sheets may gain columns without breaking the formulas. */
export function operationIndexes(header: unknown[]): Found<OperationIndexes> {
  return indexesOf(OPERATION_HEADERS, header);
}

export function accountIndexes(header: unknown[]): Found<AccountIndexes> {
  return indexesOf(ACCOUNT_HEADERS, header);
}

export interface CapitalInput {
  ops: OperationIndexes;
  accounts: AccountIndexes;
  /** 1-based row of RUB in «Курсы» (its E is RUB per USD). */
  rubRow: number;
}

const column = (sheet: string, index: number) => `'${sheet}'!$${L(index)}$2:$${L(index)}`;
const cell = (col: number, row: number) => `$${L(col)}$${row}`;
const openRow = (row: number) => `$${L(COL.matrix)}$${row}:$${row}`;
const openColumn = (col: number, from: number) => `$${L(col)}$${from}:$${L(col)}`;

const CUTOFFS = openColumn(COL.helper, ROWS.first);
const COUNT = cell(COL.helper, HELPER_ROWS.count);
const RATE = cell(COL.helper, HELPER_ROWS.rate);
const ACCOUNT_COUNT = `COUNTA(${openRow(META_ROWS.id)})`;
const MATRIX =
  `ARRAY_CONSTRAIN($${L(COL.matrix)}$${ROWS.first}:$${L(CAPITAL_COLUMNS - 1)},` +
  `${COUNT},${ACCOUNT_COUNT})`;

/** The five hidden meta rows: one TRANSPOSE(FILTER(…)) per row over the included accounts. */
export function metaFormulas({
  accounts: a,
}: CapitalInput): Record<keyof typeof META_ROWS, string> {
  const acc = (index: number) => column(ACCOUNTS_SHEET, index);
  const closed = `((${acc(a.group)}="${ARCHIVED}")+(${acc(a.type)}="${ARCHIVED}")>0)`;
  // Closed accounts are out of capital today but held money before they were closed
  const keep =
    `(${acc(a.id)}<>"")*(${acc(a.id)}<>"${HISTORY_ACCOUNT}")*` +
    `((${acc(a.inCapital)}=TRUE)+${closed}>0)`;
  const meta = (expr: string) => `=ARRAYFORMULA(TRANSPOSE(FILTER(${expr},${keep})))`;
  const rate = (index: number) =>
    `VLOOKUP(${acc(a.currency)},'${RATES_SHEET}'!$A$4:$E,${index},FALSE)`;
  return {
    id: meta(acc(a.id)),
    group: meta(`IF(${closed},"${CLOSED_GROUP}",${acc(a.group)})`),
    opening: meta(`IF(${acc(a.opening)}="",0,${acc(a.opening)})`),
    since: meta(`IF(${acc(a.since)}="",0,${acc(a.since)})`),
    factor: meta(`IF(${rate(2)}="за 1 USD",1/${rate(5)},${rate(5)})`),
  };
}

const START = cell(COL.helper, HELPER_ROWS.start);
const weekly = (dom: string) =>
  POINT_DAYS.filter((day) => day !== 1)
    .map((day) => `(${dom}=${day})`)
    .join('+');

/** Points «на утро даты»: the start, every 1st (and 9/17/25 for «Недели»), then «сейчас». */
export function cutoffsFormula(): string {
  const months = `(${cell(COL.capital, ROWS.step)}="${STEPS[1]}")`;
  return (
    `=ARRAYFORMULA(LET(today,TODAY(),start,${START},` +
    `days,SEQUENCE(today-start+1,1,start),dom,DAY(days),` +
    `VSTACK(FILTER(days,(days=start)+(dom=1)+(1-${months})*(${weekly('dom')})),${NOW_CUTOFF})))`
  );
}

/** USD balance of every included account at every cutoff of `cut` — mirrors «Счета»!J. */
function balancesFormula({ ops: o }: CapitalInput, cut: string): string {
  const op = (index: number) => column(OPERATIONS_SHEET, index);
  const window = `${op(o.date)},">="&fromDay,${op(o.date)},"<"&toDay`;
  const sum = (type: string) =>
    `SUMIFS(${op(o.amount)},${op(o.account)},accId,${op(o.type)},"${type}",${window})`;
  const meta = (row: number) => `ARRAY_CONSTRAIN(${openRow(row)},1,cnt)`;
  return (
    `=LET(cut,${cut},cnt,${ACCOUNT_COUNT},` +
    `ids,${meta(META_ROWS.id)},opening,${meta(META_ROWS.opening)},` +
    `since,${meta(META_ROWS.since)},factor,${meta(META_ROWS.factor)},` +
    `MAKEARRAY(ROWS(cut),cnt,LAMBDA(r,c,LET(accId,INDEX(ids,1,c),` +
    `fromDay,INDEX(since,1,c),toDay,INDEX(cut,r,1),` +
    `(INDEX(opening,1,c)+${sum('Доход')}-${sum('Расход')}-${sum('Перевод')}` +
    `+SUMIFS(${op(o.received)},${op(o.toAccount)},accId,${window}))*INDEX(factor,1,c)))))`
  );
}

export function matrixFormula(input: CapitalInput): string {
  return balancesFormula(input, `FILTER(${CUTOFFS},${CUTOFFS}<>"")`);
}

export function monthAgoBalancesFormula(input: CapitalInput): string {
  return balancesFormula(input, cell(COL.helper, HELPER_ROWS.monthAgo));
}

/** Row sums of the matrix over the accounts whose group passes `test`, in the chosen currency. */
function groupSum(test: string): string {
  const groups = `ARRAY_CONSTRAIN(${openRow(META_ROWS.group)},1,${ACCOUNT_COUNT})`;
  return `=ARRAYFORMULA(MMULT(${MATRIX},TRANSPOSE(--(${test.replace('$g', groups)})))*${RATE})`;
}

export function groupFormula(groupColumn: number): string {
  return groupSum(`$g=${L(groupColumn)}$${ROWS.header}`);
}

const SAVINGS_TEST = `ISNUMBER(MATCH($g,{${SAVINGS_GROUPS.map((g) => `"${g}"`).join(',')}},0))`;

export function savingsFormula(): string {
  return groupSum(SAVINGS_TEST);
}

/** Capital and savings at the «month ago» point, in the chosen currency (for the summary). */
export function monthAgoExpressions(): { capital: string; savings: string } {
  const row = `ARRAY_CONSTRAIN(${openRow(MONTH_AGO_ROW)},1,${ACCOUNT_COUNT})`;
  const groups = `ARRAY_CONSTRAIN(${openRow(META_ROWS.group)},1,${ACCOUNT_COUNT})`;
  return {
    capital: `SUM(${row})*${RATE}`,
    savings: `ARRAYFORMULA(SUMPRODUCT(${row}*${SAVINGS_TEST.replace('$g', groups)}))*${RATE}`,
  };
}

export function capitalFormula(): string {
  return `=ARRAYFORMULA(MMULT(${MATRIX},SEQUENCE(${ACCOUNT_COUNT},1,1,0))*${RATE})`;
}

/** Change against the previous point; starts one row below the first point. */
export function deltaFormula(valueColumn: number): string {
  const values = openColumn(valueColumn, ROWS.first);
  return (
    `=LET(v,FILTER(${values},${CUTOFFS}<>""),n,ROWS(v),IF(n<2,"",` +
    `MAKEARRAY(n-1,1,LAMBDA(r,c,INDEX(v,r+1,1)-INDEX(v,r,1)))))`
  );
}

export function labelFormula(): string {
  return (
    `=ARRAYFORMULA(LET(cut,FILTER(${CUTOFFS},${CUTOFFS}<>""),` +
    `IF(cut>=${NOW_CUTOFF},"сейчас",TEXT(cut,"dd.mm.yy"))))`
  );
}

export function helperFormulas(rubRow: number): Record<keyof typeof HELPER_ROWS, string> {
  return {
    rate: `=IF(${cell(COL.capital, ROWS.currency)}="RUB",'${RATES_SHEET}'!$E$${rubRow},1)`,
    count: `=COUNT(${CUTOFFS})`,
    // The first weekly point not older than a month, whatever the step: «за месяц» compares with it
    monthAgo:
      `=ARRAYFORMULA(LET(today,TODAY(),from,MAX(EDATE(today,-1),${START}),` +
      `days,SEQUENCE(today-from+1,1,from),dom,DAY(days),` +
      `MIN(FILTER(days,(days=${START})+(dom=1)+${weekly('dom')}))))`,
    start:
      `=LET(first,MINIFS(${openRow(META_ROWS.since)},${openRow(META_ROWS.since)},">0"),` +
      `IF(first=0,TODAY(),first))`,
  };
}

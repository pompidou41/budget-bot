import { HISTORY_ACCOUNT } from '../domain/reference.js';
import {
  accountIndexes,
  ARCHIVED,
  CLOSED_GROUP,
  COL,
  GROUP_COLUMNS,
  HELPER_ROWS,
  NOW_CUTOFF,
  operationIndexes,
  POINT_DAYS,
  ROWS,
  SAVINGS_GROUPS,
  STEPS,
  type AccountIndexes,
  type Step,
  type OperationIndexes,
} from './capital-layout.js';
import { columnLetter as L } from './weeks-layout.js';

const TOLERANCE = 0.01;
const ERROR_VALUE = /^(#[A-Z/0!?]+|Err:.*|Loading\.{3})$/;
const SHOWN_MISMATCHES = 3;

type Grid = unknown[][];

const text = (value: unknown) =>
  value === undefined || value === null ? '' : String(value).trim();
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value) || 0);

export interface CapitalAccount {
  id: string;
  group: string;
  opening: number;
  /** «Дата начала» serial; 0 = all movements count. */
  since: number;
  /** USD per unit of the account's currency; NaN when «Курсы» has no rate. */
  factor: number;
  /** «Остаток USD» as the sheet computed it. */
  usd: unknown;
}

function usdFactor(rates: Grid, currency: string): number {
  const row = rates.slice(3).find((r) => text(r[0]) === currency);
  const rate = row?.[4];
  if (typeof rate !== 'number' || rate === 0) return NaN;
  return text(row?.[1]) === 'за 1 USD' ? 1 / rate : rate;
}

function toAccount(row: unknown[], a: AccountIndexes, rates: Grid): CapitalAccount | null {
  const id = text(row[a.id]);
  const closed = text(row[a.group]) === ARCHIVED || text(row[a.type]) === ARCHIVED;
  if (!id || id === HISTORY_ACCOUNT || (row[a.inCapital] !== true && !closed)) return null;
  return {
    id,
    group: closed ? CLOSED_GROUP : text(row[a.group]),
    opening: num(row[a.opening]),
    since: num(row[a.since]),
    factor: usdFactor(rates, text(row[a.currency])),
    usd: row[a.usd],
  };
}

/** Accounts «Капитал» counts: in capital today, or closed (they held money before). */
export function capitalAccounts(accounts: Grid, rates: Grid): CapitalAccount[] {
  const found = accountIndexes(accounts[0] ?? []);
  if (!found.ok) throw new Error(`В шапке «Счета» нет: ${found.missing.join(', ')}`);
  return accounts.slice(1).flatMap((row) => toAccount(row, found.indexes, rates) ?? []);
}

export interface Movement {
  date: number;
  type: string;
  account: string;
  amount: number;
  toAccount: string;
  received: number;
}

export function movements(operations: Grid): Movement[] {
  const found = operationIndexes(operations[0] ?? []);
  if (!found.ok) throw new Error(`В шапке «Операции» нет: ${found.missing.join(', ')}`);
  const o: OperationIndexes = found.indexes;
  return operations.slice(1).flatMap((row) =>
    typeof row[o.date] !== 'number'
      ? []
      : [
          {
            date: row[o.date] as number,
            type: text(row[o.type]),
            account: text(row[o.account]),
            amount: num(row[o.amount]),
            toAccount: text(row[o.toAccount]),
            received: num(row[o.received]),
          },
        ],
  );
}

/** Balance in the account's currency on the morning of `cutoff`, exactly as «Счета»!J counts. */
export function balanceAt(account: CapitalAccount, ops: Movement[], cutoff: number): number {
  let balance = account.opening;
  for (const op of ops) {
    if (op.date < account.since || op.date >= cutoff) continue;
    if (op.account === account.id) balance += op.type === 'Доход' ? op.amount : 0;
    if (op.account === account.id && (op.type === 'Расход' || op.type === 'Перевод')) {
      balance -= op.amount;
    }
    if (op.toAccount === account.id) balance += op.received;
  }
  return balance;
}

export interface Point {
  cutoff: number;
  capital: number;
  savings: number;
  groups: Record<string, number>;
}

/** USD capital, savings and per-group totals at one cutoff. */
export function pointAt(accounts: CapitalAccount[], ops: Movement[], cutoff: number): Point {
  const groups: Record<string, number> = Object.fromEntries(GROUP_COLUMNS.map((g) => [g, 0]));
  let capital = 0;
  let savings = 0;
  for (const account of accounts) {
    const usd = balanceAt(account, ops, cutoff) * account.factor;
    capital += usd;
    groups[account.group] = (groups[account.group] ?? 0) + usd;
    if (SAVINGS_GROUPS.includes(account.group)) savings += usd;
  }
  return { cutoff, capital, savings, groups };
}

/** The same points the sheet's cutoff formula yields for `today` (a serial). */
const EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
const dayOfMonth = (serial: number) => new Date(EPOCH + serial * DAY_MS).getUTCDate();

function startOf(accounts: CapitalAccount[], today: number): number {
  const starts = accounts.map((a) => a.since).filter((since) => since > 0);
  return starts.length > 0 ? Math.min(...starts) : today;
}

/** Sheets' EDATE(serial, -1): the same day a month earlier, clamped to that month's end. */
function monthEarlier(serial: number): number {
  const date = new Date(EPOCH + serial * DAY_MS);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)).getUTCDate();
  const target = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() - 1,
    Math.min(date.getUTCDate(), lastDay),
  );
  return Math.round((target - EPOCH) / DAY_MS);
}

/** The same points the sheet's cutoff formula yields for `today` (a serial) and the step. */
export function cutoffPoints(accounts: CapitalAccount[], today: number, step: Step = STEPS[0]) {
  const start = startOf(accounts, today);
  const days = step === STEPS[1] ? [1] : POINT_DAYS;
  const points: number[] = [];
  for (let day = start; day <= today; day++) {
    if (day === start || days.includes(dayOfMonth(day))) points.push(day);
  }
  return [...points, NOW_CUTOFF];
}

/** The weekly point «За месяц» compares with: the first one not older than a month. */
export function monthAgoPoint(accounts: CapitalAccount[], today: number): number {
  const start = startOf(accounts, today);
  for (let day = Math.max(monthEarlier(today), start); day <= today; day++) {
    if (day === start || POINT_DAYS.includes(dayOfMonth(day))) return day;
  }
  return today;
}

function errorCells(grid: Grid): string[] {
  return grid.flatMap((line, r) =>
    line.flatMap((value, c) =>
      typeof value === 'string' && ERROR_VALUE.test(value) ? [`${L(c)}${r + 1}: ${value}`] : [],
    ),
  );
}

export interface CapitalCheck {
  problems: string[];
  notes: string[];
  points: Point[];
}

interface Row {
  cutoff: number;
  capital: number;
  savings: number;
  groupSum: number;
}

function sheetRows(sheet: Grid, rate: number): Row[] {
  const rows: Row[] = [];
  for (const line of sheet.slice(ROWS.first - 1)) {
    if (typeof line[COL.helper] !== 'number') break;
    const groupCells = line.slice(COL.firstGroup, COL.firstGroup + GROUP_COLUMNS.length);
    rows.push({
      cutoff: line[COL.helper] as number,
      capital: num(line[COL.capital]) / rate,
      savings: num(line[COL.savings]) / rate,
      groupSum: groupCells.reduce<number>((sum, value) => sum + num(value), 0) / rate,
    });
  }
  return rows;
}

function compare(rows: Row[], points: Point[]): string[] {
  const mismatches = rows.flatMap((row, i) => {
    const want = points[i]!;
    const off = Math.abs(row.capital - want.capital) > TOLERANCE;
    const savingsOff = Math.abs(row.savings - want.savings) > TOLERANCE;
    if (!off && !savingsOff) return [];
    const at = row.cutoff >= NOW_CUTOFF ? 'сейчас' : `срез ${row.cutoff}`;
    return [
      `${at}: капитал ${row.capital.toFixed(2)} ≠ ${want.capital.toFixed(2)} USD, ` +
        `сбережения ${row.savings.toFixed(2)} ≠ ${want.savings.toFixed(2)}`,
    ];
  });
  return mismatches.slice(0, SHOWN_MISMATCHES);
}

/** The «сейчас» capital must equal Σ «Счета»!K of the same accounts. */
function againstAccounts(accounts: CapitalAccount[], last: Row | undefined): string[] {
  const broken = accounts.filter((a) => typeof a.usd !== 'number' || Number.isNaN(a.factor));
  if (broken.length > 0) return [`Нет курса у счетов: ${broken.map((a) => a.id).join(', ')}`];
  const total = accounts.reduce((sum, a) => sum + (a.usd as number), 0);
  if (!last || last.cutoff < NOW_CUTOFF) return ['Последняя строка — не «сейчас»'];
  return Math.abs(last.capital - total) > TOLERANCE
    ? [`«сейчас» ${last.capital.toFixed(2)} ≠ Σ «Счета»!Остаток USD ${total.toFixed(2)}`]
    : [];
}

/** «За месяц» of the summary (column C) must equal «сейчас» minus the month-ago point. */
function summaryProblems(sheet: Grid, rate: number, now: Point, monthAgo: Point): string[] {
  const rows: [string, number, number][] = [
    ['Капитал', ROWS.capital, now.capital - monthAgo.capital],
    ['Сбережения', ROWS.savings, now.savings - monthAgo.savings],
  ];
  return rows.flatMap(([label, row, want]) => {
    const shown = num(sheet[row - 1]?.[COL.capitalDelta]) / rate;
    return Math.abs(shown - want) > TOLERANCE
      ? [`Сводка «${label}» за месяц ${shown.toFixed(2)} ≠ ${want.toFixed(2)} USD`]
      : [];
  });
}

export interface CapitalCheckInput {
  sheet: Grid;
  operations: Grid;
  accounts: Grid;
  rates: Grid;
}

/** Recomputes every point from raw values and compares it with what the sheet shows. */
export function checkCapital({
  sheet,
  operations,
  accounts,
  rates,
}: CapitalCheckInput): CapitalCheck {
  const included = capitalAccounts(accounts, rates);
  const rate = num(sheet[HELPER_ROWS.rate - 1]?.[COL.helper]) || 1;
  const rows = sheetRows(sheet, rate);
  const ops = movements(operations);
  const points = rows.map((row) => pointAt(included, ops, row.cutoff));
  const monthAgo = sheet[HELPER_ROWS.monthAgo - 1]?.[COL.helper];
  const problems = [
    ...errorCells(sheet).slice(0, SHOWN_MISMATCHES),
    ...(rows.length < 2 ? ['Меньше двух точек — формулы ещё не развернулись?'] : []),
    ...compare(rows, points),
    ...againstAccounts(included, rows.at(-1)),
    ...(typeof monthAgo === 'number' && points.length > 0
      ? summaryProblems(sheet, rate, points.at(-1)!, pointAt(included, ops, monthAgo))
      : ['Нет точки «месяц назад» в N4']),
  ];
  const last = rows.at(-1);
  const notes =
    last && Math.abs(last.groupSum - last.capital) > TOLERANCE
      ? ['Сумма колонок групп ≠ капитал: у какого-то счёта группа вне списка колонок']
      : [];
  return { problems, notes, points };
}

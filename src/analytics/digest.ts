import { weekday } from '../domain/dates.js';
import { activeAccounts, type Reference } from '../domain/reference.js';
import type { Txn } from './dataset.js';
import {
  buildMatrix,
  byCategory,
  isRegularExpense,
  monthBudget,
  periodLabel,
  periodTotals,
  recentMonths,
  recentPeriods,
  regularMonthly,
  shiftMonth,
  SPENDABLE_GROUPS,
  type MatrixRow,
} from './queries.js';

/** How many months of history go into the digest; ~13 keeps a year-over-year comparison. */
export const DIGEST_MONTHS = 13;
/** Enough weeks to see a monthly rhythm plus the run-up to it. */
export const DIGEST_WEEKS = 12;
const REGULAR_HISTORY_MONTHS = 6;
const MAX_ONE_OFF = 40;

function money(value: number): string {
  return String(Math.round(value));
}

function matrixCsv(rows: MatrixRow[], periods: string[]): string[] {
  const lines = [`категория;подкатегория;${periods.join(';')}`];
  for (const row of rows) {
    const cells = periods.map((key) => {
      const value = row.byPeriod.get(key);
      return value ? money(value) : '';
    });
    lines.push(`${row.category};${row.subcategory};${cells.join(';')}`);
  }
  return lines;
}

/**
 * Weekly slice of the same expenses. Without it the model had to fall back to raw-row
 * queries for every "how much per week" question, and often guessed the week boundaries.
 */
function weeklyBlock(txns: Txn[], today: string): string[] {
  const weeks = recentPeriods(today, 'week', DIGEST_WEEKS);
  const rows = byCategory(buildMatrix(txns, weeks, isRegularExpense, 'week'));
  const legend = weeks.map((key) => `${key}=${periodLabel(key, 'week')}`).join(', ');

  return [
    `РАСХОДЫ ПО НЕДЕЛЯМ (ISO, понедельник–воскресенье), без разовых, по категориям (USD). Недели: ${legend}`,
    ...matrixCsv(rows, weeks),
    totalsLine('ИТОГО;', periodTotals(txns, weeks, isRegularExpense, 'week'), weeks),
  ];
}

function totalsLine(label: string, totals: Map<string, number>, months: string[]): string {
  return `${label};${months.map((month) => money(totals.get(month) ?? 0)).join(';')}`;
}

function balancesBlock(ref: Reference): string[] {
  const lines = ['СЧЕТА (ID;название;валюта;остаток;остаток USD;группа):'];
  for (const account of activeAccounts(ref)) {
    lines.push(
      [
        account.id,
        account.name,
        account.currency,
        account.balance ?? '',
        account.balanceUsd === null ? '' : money(account.balanceUsd),
        account.group,
      ].join(';'),
    );
  }
  const capital = activeAccounts(ref)
    .filter((a) => a.inCapital)
    .reduce((sum, a) => sum + (a.balanceUsd ?? 0), 0);
  lines.push(`Капитал (счета «в капитале»): $${money(capital)}`);
  return lines;
}

function oneOffBlock(txns: Txn[], months: string[]): string[] {
  const window = new Set(months);
  const rows = txns
    .filter((t) => window.has(t.month) && t.type === 'Расход' && t.oneOff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_ONE_OFF);

  if (rows.length === 0) return ['РАЗОВЫЕ ТРАТЫ: нет за период.'];

  return [
    'РАЗОВЫЕ ТРАТЫ (отмечены «Разовая», в регулярные не входят) — дата;категория;подкатегория;USD;комментарий:',
    ...rows.map((t) => [t.date, t.category, t.subcategory, money(t.usd), t.comment].join(';')),
  ];
}

/**
 * The whole numeric picture, precomputed, as one prompt block. The model only picks
 * what to talk about: every figure below is already summed by us, never by the model.
 */
export function buildDigest(
  ref: Reference,
  txns: Txn[],
  today: string,
  monthsCount = DIGEST_MONTHS,
): string {
  const months = recentMonths(today, monthsCount);
  const current = today.slice(0, 7);
  const budget = monthBudget(txns, ref, today);
  const regularMonths = Array.from({ length: REGULAR_HISTORY_MONTHS }, (_, i) =>
    shiftMonth(current, i - REGULAR_HISTORY_MONTHS),
  );
  const regular = regularMonthly(txns, regularMonths);

  const expenses = buildMatrix(txns, months, isRegularExpense);
  const income = buildMatrix(txns, months, (t) => t.type === 'Доход');
  const transfers = buildMatrix(txns, months, (t) => t.type === 'Перевод');

  return [
    `Сегодня ${today} (${weekday(today)}). Все суммы ниже — в USD, пересчитаны самой таблицей.`,
    `Текущий месяц ${current}: прошло ${budget.daysPassed} из ${budget.daysTotal} дней, осталось ${budget.daysLeft}.`,
    '',
    ...balancesBlock(ref),
    '',
    'БЮДЖЕТ ТЕКУЩЕГО МЕСЯЦА (посчитано заранее, USD):',
    `- доступно на счетах групп ${SPENDABLE_GROUPS.join(' + ')}: $${money(budget.available)}`,
    `- потрачено регулярного в этом месяце: $${money(budget.spent)}`,
    `- потрачено разового в этом месяце: $${money(budget.spentOneOff)}`,
    `- типичный месяц (медиана регулярных трат за ${REGULAR_HISTORY_MONTHS} мес): $${money(budget.typical)}`,
    `- ожидается потратить до конца месяца: $${money(budget.projectedRest)}`,
    `- остаточный бюджет (доступно минус ожидаемое): $${money(budget.free)}`,
    '',
    `РЕГУЛЯРНЫЕ ТРАТЫ ПО КАТЕГОРИЯМ (медиана за ${REGULAR_HISTORY_MONTHS} мес; категория;медиана USD;максимум USD;месяцев с тратами из ${REGULAR_HISTORY_MONTHS}):`,
    ...regular.rows.map((r) => [r.category, money(r.median), money(r.max), r.monthsSeen].join(';')),
    `Сумма медиан = сколько нужно откладывать на обычный месяц: $${money(regular.total)}`,
    '',
    'РАСХОДЫ ПО МЕСЯЦАМ, без разовых (USD):',
    ...matrixCsv(expenses, months),
    totalsLine('ИТОГО;', periodTotals(txns, months, isRegularExpense), months),
    '',
    ...weeklyBlock(txns, today),
    '',
    ...oneOffBlock(txns, months),
    '',
    'ДОХОДЫ ПО МЕСЯЦАМ (USD):',
    ...matrixCsv(income, months),
    totalsLine(
      'ИТОГО;',
      periodTotals(txns, months, (t) => t.type === 'Доход'),
      months,
    ),
    '',
    'ПЕРЕВОДЫ МЕЖДУ СВОИМИ СЧЕТАМИ ПО МЕСЯЦАМ (USD; это не траты, но здесь видны платежи по кредитам и пополнение накоплений):',
    ...matrixCsv(transfers, months),
  ].join('\n');
}

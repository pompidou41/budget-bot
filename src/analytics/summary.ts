import { addDays } from '../domain/dates.js';
import { activeAccounts, type Reference } from '../domain/reference.js';
import type { Txn } from './dataset.js';
import { daysInMonth, shiftMonth, weekStart } from './queries.js';

export const SUMMARY_PERIODS = ['this_month', 'last_month', 'last_week', 'last_days'] as const;
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number];

export const MAX_SUMMARY_DAYS = 366;
const TOP_CATEGORIES = 8;

export interface DateRange {
  from: string;
  to: string;
}

const round = (value: number): number => Math.round(value);

function percentChange(current: number, previous: number): number | null {
  return previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
}

/** The asked period and the one it is compared with (same length, directly before it). */
export function resolveSummaryPeriod(
  period: SummaryPeriod,
  today: string,
  days = 30,
): { range: DateRange; previous: DateRange } {
  const month = today.slice(0, 7);

  switch (period) {
    case 'this_month': {
      const prevMonth = shiftMonth(month, -1);
      // The same number of days of the previous month, so a half-finished month is compared fairly
      const day = Math.min(Number(today.slice(8, 10)), daysInMonth(prevMonth));
      return {
        range: { from: `${month}-01`, to: today },
        previous: { from: `${prevMonth}-01`, to: `${prevMonth}-${String(day).padStart(2, '0')}` },
      };
    }
    case 'last_month': {
      const last = shiftMonth(month, -1);
      const before = shiftMonth(month, -2);
      return {
        range: { from: `${last}-01`, to: `${last}-${daysInMonth(last)}` },
        previous: { from: `${before}-01`, to: `${before}-${daysInMonth(before)}` },
      };
    }
    case 'last_week': {
      const monday = addDays(weekStart(today), -7);
      return {
        range: { from: monday, to: addDays(monday, 6) },
        previous: { from: addDays(monday, -7), to: addDays(monday, -1) },
      };
    }
    case 'last_days': {
      const length = Math.min(Math.max(Math.trunc(days), 1), MAX_SUMMARY_DAYS);
      const from = addDays(today, -(length - 1));
      return {
        range: { from, to: today },
        previous: { from: addDays(from, -length), to: addDays(from, -1) },
      };
    }
  }
}

interface Totals {
  expenses: number;
  income: number;
  oneOff: number;
  count: number;
  byCategory: Map<string, number>;
}

function totalsFor(txns: Txn[], range: DateRange): Totals {
  const totals: Totals = { expenses: 0, income: 0, oneOff: 0, count: 0, byCategory: new Map() };
  for (const txn of txns) {
    // Transfers between own accounts are neither spending nor income
    if (txn.type === 'Перевод' || txn.date < range.from || txn.date > range.to) continue;
    totals.count++;
    if (txn.type === 'Доход') {
      totals.income += txn.usd;
      continue;
    }
    totals.expenses += txn.usd;
    if (txn.oneOff) totals.oneOff += txn.usd;
    const key = txn.category || '(без категории)';
    totals.byCategory.set(key, (totals.byCategory.get(key) ?? 0) + txn.usd);
  }
  return totals;
}

/** Compact, model-friendly digest of one period for the memo-bot assistant. USD, whole dollars. */
export function buildSummary(txns: Txn[], period: SummaryPeriod, today: string, days?: number) {
  const { range, previous } = resolveSummaryPeriod(period, today, days);
  const current = totalsFor(txns, range);
  const before = totalsFor(txns, previous);

  const top = [...current.byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CATEGORIES)
    .map(([category, usd]) => ({
      category,
      usd: round(usd),
      share_pct: current.expenses > 0 ? round((usd / current.expenses) * 100) : null,
      previous_usd: round(before.byCategory.get(category) ?? 0),
    }));

  return {
    period,
    from: range.from,
    to: range.to,
    currency: 'USD',
    expenses_usd: round(current.expenses),
    income_usd: round(current.income),
    net_usd: round(current.income - current.expenses),
    one_off_expenses_usd: round(current.oneOff),
    operations: current.count,
    top_expense_categories: top,
    previous_period: {
      from: previous.from,
      to: previous.to,
      expenses_usd: round(before.expenses),
      income_usd: round(before.income),
      expenses_change_pct: percentChange(current.expenses, before.expenses),
    },
  };
}

/** Account balances like `/balance`: active accounts only, no notes or wallet addresses. */
export function buildBalances(ref: Reference) {
  const groups = new Map<string, { total: number; accounts: unknown[] }>();
  let capital = 0;

  for (const a of activeAccounts(ref)) {
    const group = groups.get(a.group || 'Без группы') ?? { total: 0, accounts: [] };
    group.total += a.balanceUsd ?? 0;
    group.accounts.push({
      id: a.id,
      name: a.name,
      currency: a.currency,
      balance: a.balance === null ? null : Math.round(a.balance * 100) / 100,
      balance_usd: a.balanceUsd === null ? null : round(a.balanceUsd),
      in_capital: a.inCapital,
    });
    if (a.inCapital) capital += a.balanceUsd ?? 0;
    groups.set(a.group || 'Без группы', group);
  }

  return {
    currency: 'USD',
    capital_usd: round(capital),
    groups: [...groups.entries()].map(([group, value]) => ({
      group,
      total_usd: round(value.total),
      accounts: value.accounts,
    })),
  };
}

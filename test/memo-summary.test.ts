import { describe, expect, it, vi } from 'vitest';
import { askFinance } from '../src/ai/ask.js';
import type { Txn } from '../src/analytics/dataset.js';
import { buildBalances, buildSummary, resolveSummaryPeriod } from '../src/analytics/summary.js';
import { renderAnswerPlain, type Answer } from '../src/domain/answer.js';
import { ref } from './fixtures.js';

function txn(overrides: Partial<Txn>): Txn {
  const date = overrides.date ?? '2026-09-10';
  return {
    date,
    month: date.slice(0, 7),
    type: 'Расход',
    account: 'T_MAIN',
    toAccount: '',
    amount: 0,
    currency: 'USD',
    usd: 0,
    rub: 0,
    category: 'Food',
    subcategory: '',
    comment: '',
    oneOff: false,
    ...overrides,
  };
}

describe('resolveSummaryPeriod', () => {
  it('this_month compares the same number of days of the previous month', () => {
    expect(resolveSummaryPeriod('this_month', '2026-03-31')).toEqual({
      range: { from: '2026-03-01', to: '2026-03-31' },
      previous: { from: '2026-02-01', to: '2026-02-28' },
    });
  });

  it('last_month and last_week are full periods with an equal one before them', () => {
    expect(resolveSummaryPeriod('last_month', '2026-10-15')).toEqual({
      range: { from: '2026-09-01', to: '2026-09-30' },
      previous: { from: '2026-08-01', to: '2026-08-31' },
    });
    // 2026-10-15 is a Thursday: the previous week is Mon 5 – Sun 11
    expect(resolveSummaryPeriod('last_week', '2026-10-15')).toEqual({
      range: { from: '2026-10-05', to: '2026-10-11' },
      previous: { from: '2026-09-28', to: '2026-10-04' },
    });
  });

  it('last_days covers N days including today and clamps N', () => {
    expect(resolveSummaryPeriod('last_days', '2026-10-15', 7).range).toEqual({
      from: '2026-10-09',
      to: '2026-10-15',
    });
    expect(resolveSummaryPeriod('last_days', '2026-10-15', 0).range.from).toBe('2026-10-15');
  });
});

describe('buildSummary', () => {
  const txns = [
    txn({ date: '2026-09-02', usd: 100, category: 'Food' }),
    txn({ date: '2026-09-05', usd: 50, category: 'Transport', oneOff: true }),
    txn({ date: '2026-09-07', usd: 2000, type: 'Доход', category: 'Income' }),
    txn({ date: '2026-09-08', usd: 700, type: 'Перевод', category: 'Transfer' }),
    txn({ date: '2026-08-03', usd: 100, category: 'Food' }),
    txn({ date: '2026-10-01', usd: 999, category: 'Food' }),
  ];

  it('totals the period, leaves transfers out and compares with the previous one', () => {
    const summary = buildSummary(txns, 'last_month', '2026-10-15');

    expect(summary).toMatchObject({
      currency: 'USD',
      from: '2026-09-01',
      to: '2026-09-30',
      expenses_usd: 150,
      income_usd: 2000,
      net_usd: 1850,
      one_off_expenses_usd: 50,
      operations: 3,
    });
    expect(summary.top_expense_categories).toEqual([
      { category: 'Food', usd: 100, share_pct: 67, previous_usd: 100 },
      { category: 'Transport', usd: 50, share_pct: 33, previous_usd: 0 },
    ]);
    expect(summary.previous_period).toMatchObject({ expenses_usd: 100, expenses_change_pct: 50 });
  });

  it('has no percentage when there is nothing to compare with', () => {
    expect(
      buildSummary([], 'this_month', '2026-10-15').previous_period.expenses_change_pct,
    ).toBeNull();
  });
});

describe('buildBalances', () => {
  it('groups active accounts, sums the capital and exposes nothing else', () => {
    const accounts = ref.accounts.map((a, i) => ({
      ...a,
      balance: 100 + i,
      balanceUsd: 10 * (i + 1),
    }));
    const result = buildBalances({ ...ref, accounts });

    // The archived account is hidden; the rest are in capital: 10 + 20 + 30 + 40
    expect(result.capital_usd).toBe(100);
    expect(result.groups.map((g) => g.group)).toEqual(['Текущие', 'Крипта']);
    expect(JSON.stringify(result)).not.toContain('ARCHIVE');
    expect(Object.keys((result.groups[0]?.accounts[0] ?? {}) as object).sort()).toEqual([
      'balance',
      'balance_usd',
      'currency',
      'id',
      'in_capital',
      'name',
    ]);
  });
});

describe('renderAnswerPlain', () => {
  const answer: Answer = {
    headline: 'Еда — $300',
    sections: [{ title: 'Детали', bullets: ['кафе <b>$100</b>', ' ', 'магазин $200'] }],
    seriesTitle: 'Динамика',
    seriesUnit: '$',
    series: [{ label: 'авг', value: 280 }],
    note: 'по данным таблицы',
  };

  it('renders plain text with no markup added', () => {
    const text = renderAnswerPlain(answer);
    expect(text).toBe(
      [
        'Еда — $300',
        'Детали\n- кафе <b>$100</b>\n- магазин $200',
        'Динамика\n- авг: $280',
        'по данным таблицы',
      ].join('\n\n'),
    );
  });

  it('says so when the model returned nothing', () => {
    const empty: Answer = { ...answer, headline: '', sections: [], series: [], note: '' };
    expect(renderAnswerPlain(empty)).toMatch(/переформулируй/);
  });
});

describe('askFinance', () => {
  const answer: Answer = {
    headline: 'ok',
    sections: [],
    seriesTitle: '',
    seriesUnit: '',
    series: [],
    note: '',
  };

  function deps(txns: Txn[]) {
    return {
      refs: { get: async () => ref, refresh: vi.fn() },
      data: { get: async () => txns, refresh: vi.fn() },
      settings: { get: () => ({ notes: [] }) },
      analyst: { ask: vi.fn(async () => answer), review: vi.fn() },
    };
  }

  it('hands the question, reference data and history to the analyst', async () => {
    const d = deps([txn({ usd: 1 })]);
    const history = [{ role: 'user' as const, content: 'раньше' }];

    // Structural stand-ins are enough: askFinance only calls get() and ask()
    const result = await askFinance(d as never, 'вопрос', history);

    expect(result).toBe(answer);
    expect(d.analyst.ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'вопрос', ref, history }),
    );
  });

  it('returns null without calling the analyst when there is no data', async () => {
    const d = deps([]);
    expect(await askFinance(d as never, 'вопрос')).toBeNull();
    expect(d.analyst.ask).not.toHaveBeenCalled();
  });
});

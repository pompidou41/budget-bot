import { describe, expect, it } from 'vitest';
import type { Txn } from '../src/analytics/dataset.js';
import { addDays } from '../src/domain/dates.js';
import { buildReviewSignals, reviewSignalsBlock, reviewWindow } from '../src/analytics/signals.js';
import type { Reference } from '../src/domain/reference.js';
import { ref as baseRef } from './fixtures.js';

const ref: Reference = {
  ...baseRef,
  accounts: [
    ...baseRef.accounts,
    {
      id: 'T_SAVE',
      name: 'Подушка',
      bank: 'Bank',
      type: 'Накопительный',
      currency: 'RUB',
      group: 'Подушка',
      inCapital: true,
      balance: null,
      balanceUsd: null,
    },
  ],
};

function txn(date: string, usd: number, overrides: Partial<Txn> = {}): Txn {
  return {
    date,
    month: date.slice(0, 7),
    type: 'Расход',
    account: 'T_MAIN',
    toAccount: '',
    amount: usd,
    currency: 'USD',
    usd,
    category: 'Food',
    subcategory: '',
    comment: '',
    oneOff: false,
    ...overrides,
  };
}

// Wednesday; the last full week is Mon 07.09 – Sun 13.09
const TODAY = '2026-09-16';
const CURRENT_WEEK = '2026-09-07';

/** Purchases spread over one week starting on `monday`. */
function week(monday: string, amounts: number[], overrides: Partial<Txn> = {}): Txn[] {
  return amounts.map((usd, i) => txn(addDays(monday, i % 7), usd, overrides));
}

describe('reviewWindow', () => {
  it('reviews the last full week against the eight before it', () => {
    const w = reviewWindow(TODAY, 'week');
    expect(w.key).toBe('2026-W37');
    expect(w.from).toBe('2026-09-07');
    expect(w.to).toBe('2026-09-13');
    expect(w.baseline).toHaveLength(8);
    expect(w.baseline.at(-1)).toBe('2026-W36');
    expect(w.title).toContain('07–13.09');
  });

  it('reviews the last full month against the six before it', () => {
    const w = reviewWindow(TODAY, 'month');
    expect(w.key).toBe('2026-08');
    expect(w.baseline).toEqual(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    expect(w.daysPassed).toBeUndefined();
  });

  it('marks the month in progress with how far into it we are', () => {
    const w = reviewWindow(TODAY, 'mtd');
    expect(w.key).toBe('2026-09');
    expect(w.daysPassed).toBe(16);
    expect(w.daysTotal).toBe(30);
  });
});

describe('buildReviewSignals', () => {
  const usualWeeks = Array.from({ length: 8 }, (_, i) =>
    week(addDays(CURRENT_WEEK, (i - 8) * 7), [20, 20, 20]),
  ).flat();

  it('compares the week with a usual one and splits "more often" from "more expensive"', () => {
    const s = buildReviewSignals(
      [...usualWeeks, ...week(CURRENT_WEEK, [23, 23, 23, 23, 23, 23])],
      ref,
      TODAY,
      'week',
    );

    expect(s.spent).toBe(138);
    expect(s.typical).toBe(60);
    expect(s.delta).toBe(78);
    expect(s.deltaPct).toBeCloseTo(1.3);

    const food = s.categories.find((c) => c.category === 'Food');
    expect(food?.count).toBe(6);
    expect(food?.typicalCount).toBe(3);
    expect(food?.avgTicket).toBe(23);
    expect(food?.typicalTicket).toBe(20);
    expect(food?.streakAbove).toBe(1);
    expect(food?.isNew).toBe(false);
  });

  it('tells a habit from a one-time spike', () => {
    const baseline = Array.from({ length: 8 }, (_, i) => {
      const amount = i >= 6 ? 90 : 50;
      return week(addDays(CURRENT_WEEK, (i - 8) * 7), [amount]);
    }).flat();

    const s = buildReviewSignals([...baseline, ...week(CURRENT_WEEK, [100])], ref, TODAY, 'week');
    // Usual is 50; the last two baseline weeks and this one are all above it
    expect(s.categories[0]?.streakAbove).toBe(3);
  });

  it('flags a category that never showed up before', () => {
    const s = buildReviewSignals(
      [...usualWeeks, ...week(CURRENT_WEEK, [40], { category: 'Transport' })],
      ref,
      TODAY,
      'week',
    );
    expect(s.categories.find((c) => c.category === 'Transport')?.isNew).toBe(true);
  });

  it('keeps one-off purchases out of spending but names them among the big ones', () => {
    const s = buildReviewSignals(
      [
        ...usualWeeks,
        ...week(CURRENT_WEEK, [20]),
        txn('2026-09-09', 400, { oneOff: true, comment: 'подарок маме' }),
      ],
      ref,
      TODAY,
      'week',
    );

    expect(s.spent).toBe(20);
    expect(s.oneOff).toBe(400);
    expect(s.bigTxns[0]).toMatchObject({ usd: 400, oneOff: true, comment: 'подарок маме' });
    expect(s.bigTxns[0]?.timesTypical).toBe(20);
  });

  it('counts income and money moved into savings, not as spending', () => {
    const s = buildReviewSignals(
      [
        ...usualWeeks,
        txn('2026-09-08', 1000, { type: 'Доход', category: 'Income' }),
        txn('2026-09-08', 200, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
        txn('2026-09-08', 50, { type: 'Перевод', category: 'Transfer', toAccount: 'ALFA_MAIN' }),
      ],
      ref,
      TODAY,
      'week',
    );

    expect(s.income).toBe(1000);
    expect(s.saved).toBe(200);
    expect(s.spent).toBe(0);
  });

  it('compares a month in progress with the same days of earlier months', () => {
    const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const history = months.flatMap((m) => [
      txn(`${m}-01`, 500, { category: 'Housing' }),
      txn(`${m}-20`, 10),
    ]);

    const s = buildReviewSignals(
      [...history, txn('2026-09-01', 500, { category: 'Housing' })],
      ref,
      '2026-09-10',
      'mtd',
    );

    // Rent on the 1st is normal by the 10th — the month must not look expensive or cheap
    expect(s.typical).toBe(500);
    expect(s.delta).toBe(0);
    expect(s.projection).toEqual({ typicalMonth: 510, expected: 510 });
  });

  it('says in the prompt block what "usual" means and where the month is heading', () => {
    const s = buildReviewSignals(
      [txn('2026-08-01', 30), txn('2026-09-05', 45)],
      ref,
      '2026-09-10',
      'mtd',
    );
    const block = reviewSignalsBlock(s);

    expect(block).toContain('«Обычно» — типичная сумма за 1 месяц');
    expect(block).toContain('Истории пока меньше обычного');
    // The owner is not a finance person; the block must not hand the model the jargon
    expect(block).not.toMatch(/медиан/i);
    expect(block).toContain('за те же первые 10 дней месяца');
    expect(block).toContain('Прогноз на весь месяц');
    expect(block).toContain('Food;');
  });
});

describe('baseline and the start of history', () => {
  it('does not count weeks before the first record as weeks of zero spending', () => {
    // History starts cleanly three weeks before the reviewed one
    const txns = [
      ...week(addDays(CURRENT_WEEK, -21), [50]),
      ...week(addDays(CURRENT_WEEK, -14), [50]),
      ...week(addDays(CURRENT_WEEK, -7), [50]),
      ...week(CURRENT_WEEK, [60]),
    ];
    const s = buildReviewSignals(txns, ref, TODAY, 'week');

    expect(s.window.baseline).toHaveLength(3);
    // Five empty weeks counted as zeros would have made «обычно» $0 and every week a spike
    expect(s.typical).toBe(50);
    expect(reviewSignalsBlock(s)).toContain('за 3 недели до этого');
  });

  it('drops the week in which history begins too late to be representative', () => {
    // 28.08 is a Friday: only three days of that week are on record
    const txns = [
      txn('2026-08-28', 5),
      ...week(addDays(CURRENT_WEEK, -7), [50]),
      ...week(CURRENT_WEEK, [60]),
    ];
    const s = buildReviewSignals(txns, ref, TODAY, 'week');

    expect(s.window.baseline).toEqual(['2026-W36']);
    expect(s.typical).toBe(50);
  });

  it('admits there is nothing to compare with on a brand-new sheet', () => {
    const s = buildReviewSignals(week(CURRENT_WEEK, [60]), ref, TODAY, 'week');

    expect(s.window.baseline).toEqual([]);
    expect(s.deltaPct).toBeNull();
    expect(reviewSignalsBlock(s)).toContain('Сравнивать пока не с чем');
  });
});

describe('a history that starts mid-period', () => {
  it('still counts a week that opens on a Thursday — most of it is on record', () => {
    const txns = [
      txn('2026-08-27', 50),
      ...week(addDays(CURRENT_WEEK, -7), [50]),
      ...week(CURRENT_WEEK, [60]),
    ];
    const s = buildReviewSignals(txns, ref, TODAY, 'week');

    expect(s.window.baseline).toEqual(['2026-W35', '2026-W36']);
  });
});

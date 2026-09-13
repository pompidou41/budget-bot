import { describe, expect, it } from 'vitest';
import { analystResponseSchema, runQueries, toAnswer } from '../src/ai/analyst.js';
import { cellToIso, parseTxns, type Txn } from '../src/analytics/dataset.js';
import { buildDigest } from '../src/analytics/digest.js';
import {
  buildMatrix,
  byCategory,
  daysInMonth,
  findTxns,
  median,
  monthBudget,
  periodTotals,
  periodLabel,
  recentMonths,
  recentPeriods,
  recordedPeriods,
  regularMonthly,
  shiftMonth,
  weekKey,
  weekStart,
} from '../src/analytics/queries.js';
import type { Reference } from '../src/domain/reference.js';
import { ref } from './fixtures.js';

const TODAY = '2026-09-11';

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
    subcategory: 'Groceries',
    comment: '',
    oneOff: false,
    ...overrides,
  };
}

describe('cellToIso', () => {
  it('reads sheet serials and typed dates', () => {
    // 46276 is 2026-09-11 in the Sheets epoch
    expect(cellToIso(46276)).toBe('2026-09-11');
    expect(cellToIso('2026-09-11')).toBe('2026-09-11');
    expect(cellToIso('05.09.2026')).toBe('2026-09-05');
  });

  it('rejects anything else', () => {
    expect(cellToIso('')).toBeNull();
    expect(cellToIso('вчера')).toBeNull();
    expect(cellToIso(0)).toBeNull();
  });
});

describe('parseTxns', () => {
  const row = (over: Record<number, unknown> = {}): unknown[] => {
    const cells: unknown[] = [
      46276,
      'Расход',
      'T_MAIN',
      1000,
      '',
      '',
      'Food',
      'Groceries',
      'лента',
    ];
    cells[9] = false;
    cells[11] = 'RUB';
    cells[13] = 11.5;
    for (const [index, value] of Object.entries(over)) cells[Number(index)] = value;
    return cells;
  };

  it('maps A:T into a typed transaction', () => {
    const [parsed] = parseTxns([row()]);
    expect(parsed).toMatchObject({
      date: '2026-09-11',
      month: '2026-09',
      type: 'Расход',
      account: 'T_MAIN',
      amount: 1000,
      currency: 'RUB',
      usd: 11.5,
      category: 'Food',
      subcategory: 'Groceries',
      comment: 'лента',
      oneOff: false,
    });
  });

  it('drops rows the sheet cannot price or date', () => {
    expect(parseTxns([row({ 0: '' })])).toHaveLength(0);
    expect(parseTxns([row({ 1: 'Списание' })])).toHaveLength(0);
    expect(parseTxns([row({ 13: '#Н/Д' })])).toHaveLength(0);
  });

  it('falls back to the amount for parity currencies', () => {
    expect(parseTxns([row({ 11: 'USDT', 13: '' })])[0]?.usd).toBe(1000);
  });

  it('reads the «Разовая» checkbox and sorts by date', () => {
    const parsed = parseTxns([row({ 9: true }), row({ 0: 46200 })]);
    expect(parsed.map((t) => t.date)).toEqual(['2026-06-27', '2026-09-11']);
    expect(parsed[1]?.oneOff).toBe(true);
  });
});

describe('month helpers', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('lists months ending with today', () => {
    expect(recentMonths(TODAY, 3)).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('knows month lengths', () => {
    expect(daysInMonth('2026-09')).toBe(30);
    expect(daysInMonth('2026-02')).toBe(28);
  });

  it('takes the median of both odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('buildMatrix', () => {
  const txns = [
    txn('2026-07-02', 10),
    txn('2026-08-02', 30),
    txn('2026-08-03', 5, { category: 'Transport', subcategory: 'Taxi & rideshare' }),
    txn('2026-06-01', 99),
  ];

  it('sums category by month inside the window, heaviest first', () => {
    const rows = buildMatrix(txns, ['2026-07', '2026-08'], () => true);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.category).toBe('Food');
    expect(rows[0]?.total).toBe(40);
    expect(rows[0]?.byPeriod.get('2026-08')).toBe(30);
    // June is outside the window
    expect(rows[0]?.byPeriod.has('2026-06')).toBe(false);
  });

  it('fills empty months with zeros in periodTotals', () => {
    const totals = periodTotals(txns, ['2026-05', '2026-07'], () => true);
    expect([...totals.entries()]).toEqual([
      ['2026-05', 0],
      ['2026-07', 10],
    ]);
  });
});

describe('regularMonthly', () => {
  const months = ['2026-06', '2026-07', '2026-08'];
  const txns = [
    txn('2026-06-01', 100),
    txn('2026-07-01', 120),
    txn('2026-08-01', 110),
    // A one-off purchase must not raise the monthly plan
    txn('2026-08-02', 900, { oneOff: true }),
    // A transfer is not spending at all
    txn('2026-08-03', 500, { type: 'Перевод', category: 'Transfer' }),
    txn('2026-08-04', 20, { category: 'Transport', subcategory: 'Taxi & rideshare' }),
  ];

  it('uses the median of regular expenses per category', () => {
    const { rows, total } = regularMonthly(txns, months);
    const food = rows.find((r) => r.category === 'Food');
    expect(food?.median).toBe(110);
    expect(food?.monthsSeen).toBe(3);

    // Taxi happened once in three months, so a typical month has none of it
    const transport = rows.find((r) => r.category === 'Transport');
    expect(transport?.median).toBe(0);
    expect(transport?.max).toBe(20);

    expect(rows.some((r) => r.category === 'Transfer')).toBe(false);
    expect(total).toBe(110);
  });
});

describe('monthBudget', () => {
  const balanced: Reference = {
    ...ref,
    accounts: ref.accounts.map((a) => ({ ...a, balanceUsd: a.id === 'T_MAIN' ? 400 : 0 })),
  };
  const txns = [
    txn('2026-06-10', 200),
    txn('2026-07-10', 300),
    txn('2026-08-10', 250),
    txn('2026-09-05', 100),
    txn('2026-09-06', 700, { oneOff: true }),
  ];

  it('projects the rest of the month from the median of past months', () => {
    const budget = monthBudget(txns, balanced, TODAY);
    expect(budget.month).toBe('2026-09');
    expect(budget.daysPassed).toBe(11);
    expect(budget.daysLeft).toBe(19);
    expect(budget.spent).toBe(100);
    expect(budget.spentOneOff).toBe(700);
    // History starts in June, so March–May are not zero-spend months: 200, 300, 250 → 250.
    // Counting them as zeros used to give 100 and hide the rest of the month entirely.
    expect(budget.typical).toBe(250);
    expect(budget.typicalMonths).toBe(3);
    expect(budget.projectedRest).toBe(150);
    expect(budget.available).toBe(400);
    expect(budget.free).toBe(250);
  });

  it('never projects a negative remainder', () => {
    const overspent = monthBudget([...txns, txn('2026-09-07', 5000)], balanced, TODAY);
    expect(overspent.projectedRest).toBe(0);
    expect(overspent.free).toBe(400);
  });
});

describe('findTxns', () => {
  const txns = [
    txn('2026-08-01', 10, { comment: 'Сытый папа' }),
    txn('2026-08-20', 40, { subcategory: 'Cafes & coffee', comment: 'скуратов' }),
    txn('2026-09-01', 70, { account: 'ALFA_MAIN' }),
  ];

  it('filters by period, category and account, newest first', () => {
    const found = findTxns(txns, { from: '2026-08-01', to: '2026-08-31', category: 'food' });
    expect(found.map((t) => t.date)).toEqual(['2026-08-20', '2026-08-01']);
    expect(findTxns(txns, { account: 'ALFA_MAIN' })).toHaveLength(1);
    expect(findTxns(txns, { subcategory: 'Cafes & coffee' })).toHaveLength(1);
  });

  it('filters by comment and minimum amount, and caps the limit', () => {
    expect(findTxns(txns, { search: 'скурат' })).toHaveLength(1);
    expect(findTxns(txns, { minUsd: 50 })).toHaveLength(1);
    expect(findTxns(txns, { limit: 1 })).toHaveLength(1);
    expect(findTxns(txns, { limit: 999 })).toHaveLength(3);
  });
});

describe('buildDigest', () => {
  const txns = [
    txn('2026-08-01', 120),
    txn('2026-09-01', 30, { subcategory: 'Cafes & coffee' }),
    txn('2026-09-02', 800, { oneOff: true, comment: 'ноутбук' }),
    txn('2026-09-03', 2000, { type: 'Доход', category: 'Income', subcategory: 'Salary' }),
  ];

  it('lays out every precomputed block the model needs', () => {
    const digest = buildDigest(ref, txns, TODAY);
    expect(digest).toContain('Сегодня 2026-09-11');
    expect(digest).toContain('БЮДЖЕТ ТЕКУЩЕГО МЕСЯЦА');
    expect(digest).toContain('РЕГУЛЯРНЫЕ ТРАТЫ ПО КАТЕГОРИЯМ');
    expect(digest).toContain('РАСХОДЫ ПО МЕСЯЦАМ');
    expect(digest).toContain('ДОХОДЫ ПО МЕСЯЦАМ');
    // The one-off laptop is listed separately, not folded into the Food row
    expect(digest).toContain('ноутбук');
    expect(digest).toMatch(/Food;Groceries;[\d;]*120/);
  });
});

describe('runQueries', () => {
  const txns = [txn('2026-08-01', 10, { comment: 'лента' })];

  it('renders rows as CSV the model can read back', () => {
    const output = runQueries(txns, [{ category: 'Food' }]);
    expect(output).toContain('строк: 1');
    expect(output).toContain('2026-08-01;Расход;T_MAIN;Food;Groceries;10;;лента');
  });

  it('says so when nothing matches', () => {
    expect(runQueries(txns, [{ category: 'Travel' }])).toContain('Ничего не найдено');
  });
});

describe('toAnswer', () => {
  it('trims, defaults the unit and caps the lists', () => {
    const answer = toAnswer({
      action: 'answer',
      queries: [],
      headline: '  Итого  ',
      sections: Array.from({ length: 9 }, () => ({ title: 't', bullets: ['a', 'b'] })),
      seriesTitle: '',
      seriesUnit: '  ',
      series: Array.from({ length: 40 }, (_, i) => ({ label: `m${i}`, value: i })),
      note: '',
    });

    expect(answer.headline).toBe('Итого');
    expect(answer.sections.length).toBeLessThanOrEqual(4);
    expect(answer.series.length).toBeLessThanOrEqual(24);
    expect(answer.seriesUnit).toBe('$');
  });
});

describe('ISO weeks', () => {
  it('starts weeks on Monday', () => {
    // 2026-09-11 is a Friday
    expect(weekStart('2026-09-11')).toBe('2026-09-07');
    expect(weekStart('2026-09-07')).toBe('2026-09-07');
    expect(weekStart('2026-09-13')).toBe('2026-09-07');
  });

  it('numbers weeks by the ISO year of their Thursday', () => {
    // 2026-01-01 is a Thursday, so it opens week 1 of 2026
    expect(weekKey('2026-01-01')).toBe('2026-W01');
    // 2026-12-31 is a Thursday too: week 53 of 2026, and it swallows 2027-01-01
    expect(weekKey('2026-12-31')).toBe('2026-W53');
    expect(weekKey('2027-01-01')).toBe('2026-W53');
    // 2025-12-29 is a Monday belonging to the first week of 2026
    expect(weekKey('2025-12-29')).toBe('2026-W01');
  });

  it('walks back whole weeks across a year boundary', () => {
    expect(recentPeriods('2027-01-06', 'week', 3)).toEqual(['2026-W52', '2026-W53', '2027-W01']);
  });

  it('labels a week by its date range', () => {
    expect(periodLabel('2026-W37', 'week')).toBe('07–13.09');
    expect(periodLabel('2026-09', 'month')).toBe('сен 26');
  });
});

describe('buildMatrix by week', () => {
  const txns = [
    txn('2026-09-07', 10),
    txn('2026-09-13', 5),
    txn('2026-09-14', 20),
    txn('2026-09-08', 7, { category: 'Transport', subcategory: 'Taxi & rideshare' }),
  ];

  it('groups by ISO week rather than by month', () => {
    const rows = byCategory(buildMatrix(txns, ['2026-W37', '2026-W38'], () => true, 'week'));

    expect(rows.map((r) => r.category)).toEqual(['Food', 'Transport']);
    expect(rows[0]?.byPeriod.get('2026-W37')).toBe(15);
    expect(rows[0]?.byPeriod.get('2026-W38')).toBe(20);
    expect(rows[1]?.byPeriod.get('2026-W37')).toBe(7);
  });

  it('drops weeks outside the window', () => {
    const rows = buildMatrix(txns, ['2026-W38'], () => true, 'week');
    expect(rows.every((r) => !r.byPeriod.has('2026-W37'))).toBe(true);
  });
});

describe('byCategory', () => {
  it('merges subcategories and keeps the heaviest first', () => {
    const rows = buildMatrix(
      [
        txn('2026-08-01', 10, { subcategory: 'Groceries' }),
        txn('2026-08-02', 30, { subcategory: 'Restaurants' }),
        txn('2026-08-03', 25, { category: 'Transport', subcategory: 'Taxi & rideshare' }),
      ],
      ['2026-08'],
      () => true,
    );

    const merged = byCategory(rows);
    expect(merged.map((r) => [r.category, r.total])).toEqual([
      ['Food', 40],
      ['Transport', 25],
    ]);
    expect(merged[0]?.subcategory).toBe('');
  });
});

describe('periodLabel across a month boundary', () => {
  it('keeps both months when the week straddles them', () => {
    // 2026-W36 runs Mon 31.08 – Sun 06.09
    expect(periodLabel('2026-W36', 'week')).toBe('31.08–06.09');
  });
});

describe('toAnswer section cleanup', () => {
  it('joins a heading-only section with the untitled bullets that follow it', () => {
    // Shape taken from a real Sonnet 5 answer: the heading and its bullets came apart
    const answer = toAnswer(
      analystResponseSchema.parse({
        action: 'answer',
        queries: [],
        headline: 'h',
        sections: [
          { title: 'Разбор', bullets: ['a'] },
          { title: 'Что с этим делать', bullets: [] },
          { title: '', bullets: ['Ограничить рестораны', ''] },
        ],
        seriesTitle: '',
        seriesUnit: '$',
        series: [],
        note: '',
      }),
    );

    expect(answer.sections).toEqual([
      { title: 'Разбор', bullets: ['a'] },
      { title: 'Что с этим делать', bullets: ['Ограничить рестораны'] },
    ]);
  });

  it('keeps leading untitled bullets as their own section', () => {
    const answer = toAnswer(
      analystResponseSchema.parse({
        action: 'answer',
        queries: [],
        headline: 'h',
        sections: [
          { title: '', bullets: ['просто факт'] },
          { title: '', bullets: [] },
        ],
        seriesTitle: '',
        seriesUnit: '$',
        series: [],
        note: '',
      }),
    );

    expect(answer.sections).toEqual([{ title: '', bullets: ['просто факт'] }]);
  });
});

describe('estimates on a short history', () => {
  it('does not count months before the first record as months without spending', () => {
    // History starts cleanly on 1 July; the budget looks six months back from September
    const txns = [txn('2026-07-01', 300), txn('2026-08-01', 300), txn('2026-09-01', 100)];
    const budget = monthBudget(txns, ref, TODAY);

    expect(budget.typicalMonths).toBe(2);
    // Four empty months counted as zeros would have made a usual month $0
    expect(budget.typical).toBe(300);
  });

  it('lists only recorded periods, dropping one where history starts part-way through', () => {
    // History opens on the 20th: most of June is not on record
    const txns = [txn('2026-06-20', 10), txn('2026-07-01', 10)];

    expect(recordedPeriods(['2026-05', '2026-06', '2026-07', '2026-08'], txns, 'month')).toEqual([
      '2026-07',
      '2026-08',
    ]);
    expect(recordedPeriods(['2026-07'], [], 'month')).toEqual([]);
  });

  it('keeps the digest free of the word the owner asked not to hear', () => {
    const digest = buildDigest(ref, [txn('2026-08-01', 10), txn('2026-09-02', 20)], TODAY);

    expect(digest).not.toMatch(/медиан/i);
    expect(digest).toContain('обычный месяц (типичная сумма регулярных трат за 1 мес.)');
  });
});

import { describe, expect, it } from 'vitest';
import { analystResponseSchema, runQueries, toAnswer } from '../src/ai/analyst.js';
import {
  cellToIso,
  createDatasetStore,
  parseRateTable,
  parseTxns,
  usdRubOn,
  type RateTable,
  type Txn,
} from '../src/analytics/dataset.js';
import { buildDigest } from '../src/analytics/digest.js';
import {
  bucketEnd,
  bucketKey,
  bucketStart,
  bucketTitle,
  buildMatrix,
  byCategory,
  daysInMonth,
  findTxns,
  median,
  monthBudget,
  periodKey,
  periodTotals,
  periodLabel,
  recentMonths,
  recentPeriods,
  recordedPeriods,
  regularMonthly,
  shiftBucket,
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
    rub: usd * 80,
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

// USD/RUB for 9 and 10 September; 90 is «Курсы».E, the current rate
const RATES: RateTable = { dates: ['2026-09-09', '2026-09-10'], usdRub: [80, 82], current: 90 };

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
    cells[11] = 46277.4; // «Добавлено»
    cells[12] = 'RUB';
    cells[14] = 11.5;
    for (const [index, value] of Object.entries(over)) cells[Number(index)] = value;
    return cells;
  };

  it('maps A:U into a typed transaction', () => {
    const [parsed] = parseTxns([row()], RATES);
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
    expect(parseTxns([row({ 0: '' })], RATES)).toHaveLength(0);
    expect(parseTxns([row({ 1: 'Списание' })], RATES)).toHaveLength(0);
    expect(parseTxns([row({ 14: '#Н/Д' })], RATES)).toHaveLength(0);
  });

  it('falls back to the amount for parity currencies', () => {
    expect(parseTxns([row({ 12: 'USDT', 14: '' })], RATES)[0]?.usd).toBe(1000);
  });

  it('reads the «Разовая» checkbox and sorts by date', () => {
    const parsed = parseTxns([row({ 9: true }), row({ 0: 46200 })], RATES);
    expect(parsed.map((t) => t.date)).toEqual(['2026-06-27', '2026-09-11']);
    expect(parsed[1]?.oneOff).toBe(true);
  });

  it('keeps the amount as rubles for a ruble account', () => {
    expect(parseTxns([row()], RATES)[0]?.rub).toBe(1000);
  });

  it('converts a dollar row at the rate of its day, taking the previous one over a gap', () => {
    // 2026-09-11 has no rate of its own: the 10th's 82 applies, like the sheet's VLOOKUP(…, TRUE)
    const [usd] = parseTxns([row({ 3: 10, 12: 'USD', 14: 10 })], RATES);
    expect(usd?.rub).toBe(820);
  });

  it('converts a lari row through its dollar value, not its nominal', () => {
    const [gel] = parseTxns([row({ 3: 27, 12: 'GEL', 14: 10 })], RATES);
    expect(gel).toMatchObject({ amount: 27, usd: 10, rub: 820 });
  });

  it('falls back to the current rate before the history starts', () => {
    // 46200 is 2026-06-27
    const [early] = parseTxns([row({ 0: 46200, 3: 10, 12: 'USD', 14: 10 })], RATES);
    expect(early?.rub).toBe(900);
  });
});

describe('createDatasetStore', () => {
  it('reads operations and the ruble rates in one request', async () => {
    const requests: { ranges?: string[] }[] = [];
    const sheets = {
      spreadsheets: {
        values: {
          batchGet: async (request: { ranges?: string[] }) => {
            requests.push(request);
            return {
              data: {
                valueRanges: [
                  {
                    values: [
                      [
                        46276,
                        'Расход',
                        'HEL_MAIN',
                        10,
                        '',
                        '',
                        'Food',
                        '',
                        '',
                        false,
                        '',
                        '',
                        'USD',
                        1,
                        10,
                      ],
                    ],
                  },
                  { values: [[46275, 80]] },
                  { values: [['RUB', 'за 1 USD', 82, '', 85]] },
                ],
              },
            };
          },
        },
      },
    };

    const store = createDatasetStore(
      sheets as unknown as Parameters<typeof createDatasetStore>[0],
      'sheet-id',
    );
    const [parsed] = await store.get();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.ranges).toEqual(['Операции!A2:U', 'Курсы!H4:I', 'Курсы!A4:E']);
    // 2026-09-11 has no rate; the 10th's 80 applies
    expect(parsed).toMatchObject({ currency: 'USD', usd: 10, rub: 800 });
  });
});

describe('usdRubOn', () => {
  it('takes the rate of the exact day', () => {
    expect(usdRubOn('2026-09-09', RATES)).toBe(80);
    expect(usdRubOn('2026-09-10', RATES)).toBe(82);
  });

  it('takes the latest earlier rate over a gap and after the last day', () => {
    const gappy: RateTable = { ...RATES, dates: ['2026-09-01', '2026-09-05'], usdRub: [79, 81] };
    expect(usdRubOn('2026-09-03', gappy)).toBe(79);
    expect(usdRubOn('2026-12-31', gappy)).toBe(81);
  });

  it('uses the current rate before the history and without any history', () => {
    expect(usdRubOn('2026-09-08', RATES)).toBe(90);
    expect(usdRubOn('2026-09-08', { dates: [], usdRub: [], current: 77 })).toBe(77);
  });
});

describe('parseRateTable', () => {
  const currencies = [
    ['USD', 'USD за 1', 1, '', 1],
    ['RUB', 'за 1 USD', 82.6, '', 83.5],
  ];

  it('reads the daily history and the current ruble rate', () => {
    // 46275 and 46276 are 2026-09-10 and 2026-09-11; the later row comes first on purpose
    const table = parseRateTable(
      [
        [46276, 82.1],
        [46275, 81.9],
        ['', ''],
        ['Date', '#N/A'],
      ],
      currencies,
    );
    expect(table).toEqual({
      dates: ['2026-09-10', '2026-09-11'],
      usdRub: [81.9, 82.1],
      current: 83.5,
    });
  });

  it('falls back to the latest daily rate without a current RUB rate', () => {
    const table = parseRateTable([[46275, 81.9]], [['USD', 'USD за 1', 1, '', 1]]);
    expect(table.current).toBe(81.9);
  });

  it('keeps loading with no ruble rate at all, rubles reading zero', () => {
    expect(parseRateTable([], [['USD', 'USD за 1', 1, '', 1]]).current).toBe(0);
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

describe('buildMatrix in rubles', () => {
  // A lari purchase worth $10, i.e. 820 ₽ at the day's rate
  const txns = [txn('2026-09-10', 10, { currency: 'GEL', amount: 27, rub: 820 })];

  it('adds up the ruble amount instead of the dollar one', () => {
    const [row] = buildMatrix(txns, ['2026-09'], () => true, 'month', 'rub');
    expect(row?.total).toBe(820);
    expect(buildMatrix(txns, ['2026-09'], () => true)[0]?.total).toBe(10);
  });

  it('does the same for the per-period totals', () => {
    expect(periodTotals(txns, ['2026-09'], () => true, 'month', 'rub').get('2026-09')).toBe(820);
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

describe('periodKey', () => {
  it('names the period a date falls into, for every kind of period', () => {
    expect(periodKey('2026-10-12', 'week')).toBe('2026-W42');
    expect(periodKey('2026-10-12', 'month')).toBe('2026-10');
    expect(periodKey('2026-10-12', 'bucket')).toBe('2026-10-b2');
  });
});

describe('week buckets', () => {
  it('cuts a month at days 8, 16 and 24', () => {
    expect(
      ['01', '08', '09', '16', '17', '24', '25', '31'].map((d) => bucketKey(`2026-10-${d}`)),
    ).toEqual([
      '2026-10-b1',
      '2026-10-b1',
      '2026-10-b2',
      '2026-10-b2',
      '2026-10-b3',
      '2026-10-b3',
      '2026-10-b4',
      '2026-10-b4',
    ]);
  });

  it('starts and ends each bucket on its own days', () => {
    expect([1, 2, 3, 4].map((n) => bucketStart(`2026-10-b${n}`))).toEqual([
      '2026-10-01',
      '2026-10-09',
      '2026-10-17',
      '2026-10-25',
    ]);
    expect([1, 2, 3].map((n) => bucketEnd(`2026-10-b${n}`))).toEqual([
      '2026-10-08',
      '2026-10-16',
      '2026-10-24',
    ]);
  });

  it('ends the last bucket with its month, leap years included', () => {
    expect(bucketEnd('2026-10-b4')).toBe('2026-10-31');
    expect(bucketEnd('2026-09-b4')).toBe('2026-09-30');
    expect(bucketEnd('2027-02-b4')).toBe('2027-02-28');
    expect(bucketEnd('2028-02-b4')).toBe('2028-02-29');
    expect(bucketKey('2028-02-29')).toBe('2028-02-b4');
  });

  it('shifts across month and year boundaries', () => {
    expect(shiftBucket('2026-10-b2', 1)).toBe('2026-10-b3');
    expect(shiftBucket('2026-10-b4', 1)).toBe('2026-11-b1');
    expect(shiftBucket('2026-12-b4', 1)).toBe('2027-01-b1');
    expect(shiftBucket('2027-01-b1', -1)).toBe('2026-12-b4');
    expect(shiftBucket('2026-10-b3', -7)).toBe('2026-08-b4');
    expect(shiftBucket('2026-10-b3', 0)).toBe('2026-10-b3');
  });

  it('labels a bucket by its days, short in a column and in full in a sentence', () => {
    expect(periodLabel('2026-10-b1', 'bucket')).toBe('1–8 окт');
    expect(periodLabel('2026-10-b4', 'bucket')).toBe('25–31 окт');
    expect(periodLabel('2027-02-b4', 'bucket')).toBe('25–28 фев');
    expect(bucketTitle('2026-10-b1')).toBe('1–8 октября');
    expect(bucketTitle('2028-02-b4')).toBe('25–29 февраля');
    expect(bucketTitle('2026-05-b2')).toBe('9–16 мая');
  });

  it('lists the buckets ending with the one that holds today', () => {
    expect(recentPeriods('2026-10-17', 'bucket', 3)).toEqual([
      '2026-10-b1',
      '2026-10-b2',
      '2026-10-b3',
    ]);
    expect(recentPeriods('2027-01-10', 'bucket', 3)).toEqual([
      '2026-12-b4',
      '2027-01-b1',
      '2027-01-b2',
    ]);
  });

  it('counts the bucket where history begins when it opens within three days of its start', () => {
    const keys = ['2026-09-b1', '2026-09-b2', '2026-09-b3'];
    // The 12th is the fourth day of 9–16: still most of the bucket
    expect(recordedPeriods(keys, [txn('2026-09-12', 10)], 'bucket')).toEqual([
      '2026-09-b2',
      '2026-09-b3',
    ]);
    // The 13th is the fifth: the bucket is half gone, so it would pass for a cheap one
    expect(recordedPeriods(keys, [txn('2026-09-13', 10)], 'bucket')).toEqual(['2026-09-b3']);
  });

  it('groups a matrix by bucket, in either currency', () => {
    const txns = [
      txn('2026-10-08', 10),
      txn('2026-10-09', 20, { rub: 1700 }),
      txn('2026-10-24', 5),
      txn('2026-11-01', 99),
    ];
    const periods = ['2026-10-b1', '2026-10-b2', '2026-10-b3'];

    const [usd] = buildMatrix(txns, periods, () => true, 'bucket');
    expect([...(usd?.byPeriod ?? [])]).toEqual([
      ['2026-10-b1', 10],
      ['2026-10-b2', 20],
      ['2026-10-b3', 5],
    ]);

    const [rub] = buildMatrix(txns, periods, () => true, 'bucket', 'rub');
    expect(rub?.byPeriod.get('2026-10-b2')).toBe(1700);
    expect(periodTotals(txns, periods, () => true, 'bucket').get('2026-10-b1')).toBe(10);
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

describe('the digest weekly slice', () => {
  const IMPORTED = 'Импорт из «копия Сводки»: ';

  it('shows only real weeks, so a summary total cannot pass for one week of spending', () => {
    const digest = buildDigest(
      ref,
      [
        txn('2026-08-17', 418, {
          account: 'ARCHIVE',
          category: 'Food',
          comment: `${IMPORTED}Продукты`,
        }),
        txn('2026-08-31', 12, { comment: 'Пятёрочка' }),
        txn('2026-09-08', 40, { comment: 'Перекрёсток' }),
      ],
      TODAY,
    );

    expect(digest).toContain('только недели с живыми операциями');
    expect(digest).toContain('2026-W36=31.08–06.09');
    expect(digest).not.toContain('2026-W34=');
  });

  it('says there is no weekly slice while history is summaries only', () => {
    const digest = buildDigest(
      ref,
      [txn('2026-08-17', 418, { account: 'ARCHIVE', comment: `${IMPORTED}Продукты` })],
      TODAY,
    );

    expect(digest).toContain('живых операций по неделям пока нет');
  });
});

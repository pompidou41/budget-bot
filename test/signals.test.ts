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

describe('context from real-shaped data', () => {
  const IMPORTED = 'Импорт из «копия Сводки»: ';
  const priorMonths = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

  // Six months of imported totals dated the 1st/9th/17th/25th, then real operations from 1 September
  const summaries = priorMonths.flatMap((m) => [
    ...['01', '09', '17', '25'].map((d) =>
      txn(`${m}-${d}`, 76, {
        account: 'ARCHIVE',
        subcategory: 'Groceries',
        comment: `${IMPORTED}Продукты`,
      }),
    ),
    txn(`${m}-01`, 500, {
      account: 'ARCHIVE',
      category: 'Housing',
      subcategory: 'Rent',
      comment: `${IMPORTED}Квартира`,
    }),
  ]);
  const live = [
    txn('2026-09-01', 500, { category: 'Housing', subcategory: 'Rent', comment: 'Квартира' }),
    txn('2026-09-01', 40, { subcategory: 'Groceries', comment: 'Пятёрочка' }),
    txn('2026-09-08', 40, { subcategory: 'Groceries', comment: 'Перекрёсток' }),
    txn('2026-09-09', 40, { subcategory: 'Groceries', comment: 'Перекрёсток' }),
    txn('2026-09-11', 40, { subcategory: 'Groceries', comment: 'Перекрёсток' }),
    txn('2026-09-12', 88, { category: 'Liza', subcategory: 'Flowers', comment: 'Цветовик' }),
    txn('2026-09-10', 1857, {
      type: 'Доход',
      category: 'Income',
      subcategory: 'Salary',
      account: 'ALFA_MAIN',
      comment: 'Зарплата',
    }),
    txn('2026-09-10', 186, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
  ];
  const all = [...summaries, ...live];

  it('keeps summary weeks and the empty weeks between them out of the weekly baseline', () => {
    const s = buildReviewSignals(all, ref, TODAY, 'week');

    // Only the first real week counts; the gaps between summary dates are not weeks without spending
    expect(s.window.baseline).toEqual(['2026-W36']);
    expect(s.approximate).toBe('monthly');
    // A usual month is $304 of groceries + $500 rent; a usual week is its share of that
    expect(s.typical).toBeCloseTo((804 * 7) / 30.4, 1);
    expect(s.categories.find((c) => c.category === 'Liza')?.isNew).toBe(true);
  });

  it('tells how the salary was laid out and how long ago it came', () => {
    const s = buildReviewSignals(all, ref, TODAY, 'week');

    expect(s.money).toHaveLength(1);
    expect(s.money[0]).toMatchObject({ what: 'Зарплата', usd: 1857 });
    expect(s.money[0]?.moves).toHaveLength(1);
    expect(s.daysSinceSalary).toBe(3);
  });

  it('separates rent from spending that choices move', () => {
    const s = buildReviewSignals(all, ref, TODAY, 'mtd');

    expect(s.obligations.map((p) => p.key)).toContain('Housing/Rent');
    expect(s.fixed).toBe(500);
    expect(s.flexible).toBe(s.spent - 500);
    // Earlier months are summaries, so a same-days comparison is only approximate
    expect(s.approximate).toBe('summaries');
  });

  it('names the places behind the categories that moved', () => {
    const s = buildReviewSignals(all, ref, TODAY, 'mtd');
    const food = s.compositions.find((c) => c.category === 'Food');

    expect(food?.places[0]).toEqual({ label: 'Перекрёсток', count: 3, usd: 120 });
    expect(s.compositions.find((c) => c.category === 'Liza')?.places[0]?.label).toBe('Цветовик');
  });

  it('puts money, obligations, places and the day-by-day feed into the prompt block', () => {
    const block = reviewSignalsBlock(buildReviewSignals(all, ref, TODAY, 'mtd'));

    expect(block).toContain('ДЕНЬГИ');
    expect(block).toContain('10.09 Зарплата $1857');
    expect(block).toContain('обязательные платежи: $500');
    expect(block).toContain('Перекрёсток ×3 $120');
    expect(block).toContain('ЛЕНТА ПО ДНЯМ');
    expect(block).toContain('примерное');
    expect(block).not.toMatch(/медиан/i);
    expect(block).not.toContain('Импорт из');
  });

  it('treats a whole past month of summaries as exact and skips the feed', () => {
    const s = buildReviewSignals(all, ref, TODAY, 'month');

    expect(s.approximate).toBeUndefined();
    expect(s.timeline).toEqual([]);
  });
});

describe('honest comparisons against summaries', () => {
  const IMPORTED = 'Импорт из «копия Сводки»: ';
  const priorMonths = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
  const summaries = priorMonths.flatMap((m) =>
    ['01', '09', '17', '25'].map((d) =>
      txn(`${m}-${d}`, 76, {
        account: 'ARCHIVE',
        subcategory: 'Groceries',
        comment: `${IMPORTED}Продукты`,
      }),
    ),
  );
  const live = [
    ...['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-08', '2026-09-09'].map((d) =>
      txn(d, 12, { subcategory: 'Groceries', comment: 'Пятёрочка' }),
    ),
    txn('2026-09-10', 25, { subcategory: 'Restaurants', comment: 'Токио-City' }),
  ];
  const all = [...summaries, ...live];

  it('does not compare purchase counts or tickets with summary rows', () => {
    // Real run: "19 purchases instead of the usual 4, $12 each instead of $101" — a summary artefact
    const s = buildReviewSignals(all, ref, TODAY, 'mtd');
    const food = s.categories.find((c) => c.category === 'Food');

    expect(food?.count).toBe(6);
    expect(food?.typicalCount).toBeNull();
    expect(food?.typicalTicket).toBeNull();
    expect(reviewSignalsBlock(s)).toMatch(/Food;[^\n]*;6\/—;\$\d+\/—;/);
  });

  it('gives no subcategory usual level from a single real week', () => {
    // Real run: "restaurants usually $0" came from the only live week before the reviewed one
    const s = buildReviewSignals(all, ref, TODAY, 'week');
    const food = s.compositions.find((c) => c.category === 'Food');

    expect(s.approximate).toBe('monthly');
    expect(food?.subcategories.every((sub) => sub.typical === null)).toBe(true);
  });

  it('says when real operations started, so a missing bill is not read as no spending', () => {
    const block = reviewSignalsBlock(buildReviewSignals(all, ref, TODAY, 'mtd'));

    expect(block).toContain('записываются с 01.09.2026');
    expect(block).toContain('не утверждай, что трат не было');
  });

  it('tells the model not to build the headline on a rough comparison', () => {
    const block = reviewSignalsBlock(buildReviewSignals(all, ref, TODAY, 'week'));

    expect(block).toContain('Не делай из разницы с «обычно» главный вывод');
    // An estimated week must not also claim a one-week baseline
    expect(block).toContain('примерная доля обычного месяца');
    expect(block).not.toContain('типичная сумма за 1 неделю');
  });

  it('says nothing about summaries once history is all real operations', () => {
    const block = reviewSignalsBlock(buildReviewSignals(live, ref, '2026-09-10', 'mtd'));

    expect(block).not.toContain('записываются с');
    expect(block).not.toContain('ВАЖНО');
  });
});

describe('what the second real run got wrong', () => {
  const IMPORTED = 'Импорт из «копия Сводки»: ';
  const summaries = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].flatMap(
    (m) =>
      ['01', '09', '17', '25'].map((d) =>
        txn(`${m}-${d}`, 50, {
          account: 'ARCHIVE',
          category: 'Liza',
          subcategory: '',
          comment: `${IMPORTED}Лиза`,
        }),
      ),
  );
  const live = [
    txn('2026-09-04', 466, {
      type: 'Доход',
      category: 'Income',
      subcategory: 'Other',
      comment: 'Перевод от Джалил А.',
    }),
    txn('2026-09-04', 350, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
    txn('2026-09-10', 1857, {
      type: 'Доход',
      category: 'Income',
      subcategory: 'Salary',
      account: 'ALFA_MAIN',
      comment: 'Зарплата',
    }),
    txn('2026-09-10', 1857, {
      type: 'Перевод',
      category: 'Transfer',
      account: 'ALFA_MAIN',
      toAccount: 'T_MAIN',
    }),
    txn('2026-09-10', 186, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
    txn('2026-09-12', 88, { category: 'Liza', subcategory: 'Flowers', comment: 'Цветовик' }),
  ];
  const all = [...summaries, ...live];

  it('hands over the laid-out totals so the model does not add them up itself', () => {
    // Real run: «$786 в Подушку» where the transfers were 350 + 186
    const block = reviewSignalsBlock(buildReviewSignals(all, ref, TODAY, 'mtd'));

    expect(block).toContain('Итого разложено');
    expect(block).toContain('Подушка, Bank $536');
    // Moving money between everyday cards is not laying it out
    expect(block).not.toMatch(/Итого разложено[^\n]*T_MAIN/);
  });

  it('names a same-days usual level so it is not read as a monthly one', () => {
    // Real run: «keep Liza within $200 a month» where $200 was the usual by the 16th
    const block = reviewSignalsBlock(buildReviewSignals(all, ref, TODAY, 'mtd'));

    expect(block).toContain('обычно к 16-му дню месяца (не за весь месяц)');
  });

  it('shows an unknown streak as unknown, not as zero', () => {
    // Real run: «0 periods in a row» became «this never happened before»
    const s = buildReviewSignals(all, ref, TODAY, 'week');

    expect(s.approximate).toBe('monthly');
    expect(s.categories.every((c) => c.streakAbove === null)).toBe(true);
  });

  it('never hands the model the word it repeated to the owner', () => {
    for (const scope of ['week', 'mtd', 'month'] as const) {
      expect(reviewSignalsBlock(buildReviewSignals(all, ref, TODAY, scope))).not.toMatch(/сводк/i);
    }
  });
});

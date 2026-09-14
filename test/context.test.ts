import { describe, expect, it } from 'vitest';
import {
  cleanComment,
  composition,
  daysSinceSalary,
  isSummary,
  liveWeeks,
  moneyFlow,
  normalizeComment,
  obligationKey,
  obligations,
  timeline,
} from '../src/analytics/context.js';
import type { Txn } from '../src/analytics/dataset.js';
import type { Account, Reference } from '../src/domain/reference.js';
import { ref as baseRef } from './fixtures.js';

function account(id: string, name: string, group: string): Account {
  return {
    id,
    name,
    bank: 'Т-Банк',
    type: 'Накопительный',
    currency: 'RUB',
    group,
    inCapital: true,
    balance: null,
    balanceUsd: null,
  };
}

const ref: Reference = {
  ...baseRef,
  accounts: [
    ...baseRef.accounts,
    account('T_SACC', 'Машина', 'Накопления'),
    account('T_SAVE', 'НЗ', 'Подушка'),
    account('T_CONST', 'Постоянные расходы', 'Ежемесячные'),
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
    subcategory: 'Groceries',
    comment: '',
    oneOff: false,
    ...overrides,
  };
}

const IMPORTED = 'Импорт из «копия Сводки»: ';

describe('comments', () => {
  it('drops the import prefix', () => {
    expect(cleanComment(`${IMPORTED}Квартира`)).toBe('Квартира');
    expect(cleanComment('Пятёрочка')).toBe('Пятёрочка');
  });

  it('treats a transfer to a person and a payment to them as the same person', () => {
    expect(normalizeComment('Перевод Елизавета С.')).toBe(normalizeComment('Елизавета С.'));
    expect(normalizeComment('Перевод от Джалил А.')).toBe('джалил а');
    expect(normalizeComment('Пятёрочка')).toBe(normalizeComment('Пятерочка'));
  });

  it('recognises summary rows by the archive account or the import prefix', () => {
    expect(isSummary(txn('2026-08-17', 186, { account: 'ARCHIVE' }), ref)).toBe(true);
    expect(isSummary(txn('2026-08-17', 186, { comment: `${IMPORTED}Продукты` }), ref)).toBe(true);
    expect(isSummary(txn('2026-09-09', 59, { comment: 'Перекрёсток' }), ref)).toBe(false);
  });
});

describe('moneyFlow', () => {
  // The owner's real 10.09: salary lands on Alfa and is laid out over the next three days
  const txns = [
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
    txn('2026-09-10', 613, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SACC' }),
    txn('2026-09-10', 186, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
    txn('2026-09-13', 593, { type: 'Перевод', category: 'Transfer', toAccount: 'T_CONST' }),
    txn('2026-09-20', 400, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
    txn('2026-09-11', 20, {
      type: 'Доход',
      category: 'Income',
      subcategory: 'Cashback',
      comment: 'Кэшбэк',
    }),
  ];

  it('chains the income with the transfers that followed it within three days', () => {
    const [salary, ...rest] = moneyFlow(txns, ref, '2026-09-07', '2026-09-13');

    expect(rest).toHaveLength(0);
    expect(salary).toMatchObject({
      date: '2026-09-10',
      what: 'Зарплата',
      isSalary: true,
      usd: 1857,
      account: 'ALFA_MAIN name, Bank',
    });
    // Same-named accounts at different banks must stay distinguishable
    expect(salary?.moves.map((m) => [m.to, m.group, m.usd])).toEqual([
      ['T_MAIN name, Bank', 'Текущие', 1857],
      ['Машина, Т-Банк', 'Накопления', 613],
      ['НЗ, Т-Банк', 'Подушка', 186],
      ['Постоянные расходы, Т-Банк', 'Ежемесячные', 593],
    ]);
  });

  it('ignores cashback-sized income and transfers made long after', () => {
    const flow = moneyFlow(txns, ref, '2026-09-01', '2026-09-30');
    expect(flow).toHaveLength(1);
    expect(flow[0]?.moves.some((m) => m.date === '2026-09-20')).toBe(false);
  });

  it('gives a transfer to the latest money that arrived before it', () => {
    const flow = moneyFlow(
      [
        txn('2026-09-04', 466, {
          type: 'Доход',
          category: 'Income',
          subcategory: 'Other',
          comment: 'Перевод от Джалил А.',
        }),
        txn('2026-09-05', 1000, {
          type: 'Доход',
          category: 'Income',
          subcategory: 'Salary',
          comment: 'Зарплата',
        }),
        txn('2026-09-06', 300, { type: 'Перевод', category: 'Transfer', toAccount: 'T_SAVE' }),
      ],
      ref,
      '2026-09-01',
      '2026-09-30',
    );
    expect(flow[0]?.moves).toHaveLength(0);
    expect(flow[1]?.moves).toHaveLength(1);
  });

  it('names no account for income carried over from the summary sheet', () => {
    const [arrival] = moneyFlow(
      [
        txn('2026-08-09', 1948, {
          type: 'Доход',
          category: 'Income',
          subcategory: 'Salary',
          account: 'ARCHIVE',
          comment: `${IMPORTED}Зарплата`,
        }),
      ],
      ref,
      '2026-08-01',
      '2026-08-31',
    );
    expect(arrival).toMatchObject({ what: 'Зарплата', account: '' });
  });

  it('counts days since salary without guessing the next one', () => {
    expect(daysSinceSalary(txns, '2026-09-14')).toBe(4);
    expect(daysSinceSalary([], '2026-09-14')).toBeUndefined();
  });
});

describe('composition', () => {
  it('names the places and people behind a category, merging spellings', () => {
    const current = [
      txn('2026-09-12', 88, { category: 'Liza', subcategory: 'Flowers', comment: 'Цветовик' }),
      txn('2026-09-03', 30, { category: 'Liza', subcategory: 'Other', comment: 'Елизавета С.' }),
      txn('2026-09-04', 12, {
        category: 'Liza',
        subcategory: 'Other',
        comment: 'Перевод Елизавета С.',
      }),
      txn('2026-09-13', 8, { category: 'Liza', subcategory: 'Other', comment: 'Елизавета С.' }),
    ];
    const result = composition('Liza', current, [], ref);

    expect(result.places[0]).toEqual({ label: 'Цветовик', count: 1, usd: 88 });
    expect(result.places[1]).toEqual({ label: 'Елизавета С.', count: 3, usd: 50 });
  });

  it('compares subcategories only with real operations, never with summaries', () => {
    const current = [txn('2026-09-09', 59, { comment: 'Перекрёсток' })];
    const summaries = [
      [txn('2026-08-17', 186, { account: 'ARCHIVE', comment: `${IMPORTED}Продукты` })],
    ];
    const live = [[txn('2026-08-10', 40, { comment: 'Магнит' })], [txn('2026-08-03', 60)]];

    expect(composition('Food', current, summaries, ref).subcategories[0]?.typical).toBeNull();
    expect(composition('Food', current, live, ref).subcategories[0]?.typical).toBe(50);
  });

  it('leaves summary rows out of places — they name a budget line, not a shop', () => {
    const current = [
      txn('2026-08-17', 186, { account: 'ARCHIVE', comment: `${IMPORTED}Продукты` }),
    ];
    expect(composition('Food', current, [], ref).places).toEqual([]);
  });
});

describe('obligations', () => {
  const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

  it('knows a bill by the sheet taxonomy, not by how often it appears', () => {
    expect(
      obligationKey(txn('2026-09-01', 500, { category: 'Housing', subcategory: 'Rent' })),
    ).toBe('Housing/Rent');
    expect(
      obligationKey(
        txn('2026-09-07', 9, { category: 'Subscriptions', subcategory: 'Mobile plan' }),
      ),
    ).toBe('Subscriptions/Mobile plan');
    expect(obligationKey(txn('2026-09-09', 59))).toBeNull();
    expect(
      obligationKey(
        txn('2026-09-01', 500, { category: 'Housing', subcategory: 'Rent', oneOff: true }),
      ),
    ).toBeNull();
  });

  it('gives rent its usual monthly cost and the owner’s own name for it', () => {
    const rent = ['2026-03', '2026-04', '2026-06', '2026-07', '2026-08'].map((m, i) =>
      txn(`${m}-01`, 480 + i * 5, {
        account: 'ARCHIVE',
        category: 'Housing',
        subcategory: 'Rent',
        comment: `${IMPORTED}Квартира`,
      }),
    );
    const [payment] = obligations(rent, months);

    expect(payment).toMatchObject({ key: 'Housing/Rent', label: 'Квартира', monthsSeen: 5 });
    expect(payment?.typicalMonthly).toBe(490);
  });

  it('sums summary rows per month, so four rows of subscriptions are one monthly cost', () => {
    const subscriptions = months.slice(2).flatMap((m) =>
      ['01', '09', '17'].map((d) =>
        txn(`${m}-${d}`, 20, {
          account: 'ARCHIVE',
          category: 'Subscriptions',
          subcategory: '',
          comment: `${IMPORTED}Подписки, связь, интернет`,
        }),
      ),
    );
    const [payment] = obligations(subscriptions, months);

    expect(payment).toMatchObject({ key: 'Subscriptions', label: 'Subscriptions', monthsSeen: 4 });
    expect(payment?.typicalMonthly).toBe(60);
  });

  it('does not call groceries a bill, however regular they are', () => {
    const groceries = months.flatMap((m) =>
      Array.from({ length: 8 }, (_, i) => txn(`${m}-${String(i * 3 + 1).padStart(2, '0')}`, 20)),
    );
    expect(obligations(groceries, months)).toEqual([]);
  });

  it('needs more than one month to know what a bill usually costs', () => {
    const once = [txn('2026-08-01', 500, { category: 'Housing', subcategory: 'Rent' })];
    expect(obligations(once, months)).toEqual([]);
  });
});

describe('timeline', () => {
  it('lists real operations day by day, without summaries', () => {
    const lines = timeline(
      [
        txn('2026-09-12', 88, { category: 'Liza', subcategory: 'Flowers', comment: 'Цветовик' }),
        txn('2026-09-12', 14, {
          category: 'Entertainment',
          subcategory: 'Other',
          comment: 'Красное и белое',
        }),
        txn('2026-09-09', 186, { account: 'ARCHIVE', comment: `${IMPORTED}Продукты` }),
      ],
      ref,
      '2026-09-07',
      '2026-09-13',
    );

    expect(lines).toEqual([
      'сб 12.09 · Liza/Flowers · $88 · Цветовик',
      'сб 12.09 · Entertainment/Other · $14 · Красное и белое',
    ]);
  });

  it('collapses days into category totals past the limit', () => {
    const busy = Array.from({ length: 30 }, (_, i) =>
      txn(`2026-09-${String((i % 5) + 8).padStart(2, '0')}`, 10, { comment: `магазин ${i}` }),
    );
    const lines = timeline(busy, ref, '2026-09-07', '2026-09-13', 20);

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('вт 08.09 · Food $60 (6)');
  });
});

describe('liveWeeks', () => {
  const weeks = ['2026-W33', '2026-W34', '2026-W35', '2026-W36', '2026-W37'];

  it('keeps only weeks from the first real operation on, without summary rows', () => {
    const txns = [
      txn('2026-08-17', 418, { account: 'ARCHIVE', category: 'Liza', comment: `${IMPORTED}Лиза` }),
      txn('2026-08-31', 12, { comment: 'Пятёрочка' }),
      txn('2026-09-12', 88, { category: 'Liza', comment: 'Цветовик' }),
    ];
    // W33 and W35 hold no summary, but they come before any real operation: empty is not zero
    expect(liveWeeks(weeks, txns, ref)).toEqual(['2026-W36', '2026-W37']);
  });

  it('keeps every recorded week once history is all real operations', () => {
    const txns = [txn('2026-08-10', 12), txn('2026-09-12', 20)];
    expect(liveWeeks(weeks, txns, ref)).toEqual(weeks);
  });
});

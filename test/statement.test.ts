import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import type { Txn } from '../src/analytics/dataset.js';
import type { Existing } from '../src/domain/duplicates.js';
import type { Reference } from '../src/domain/reference.js';
import { resolveAccount } from '../src/statement/account.js';
import { bookingHistory } from '../src/statement/history.js';
import {
  effectOn,
  missingFromStatement,
  planImport,
  rowToOperation,
  type RowGuess,
} from '../src/statement/plan.js';
import {
  parseMoney,
  purchaseDate,
  verifyBalances,
  type Statement,
  type StatementRow,
} from '../src/statement/statement.js';
import { parseWorkbook, readWorkbook } from '../src/statement/xlsx.js';
import { ref as baseRef } from './fixtures.js';

const ref: Reference = {
  ...baseRef,
  accounts: [
    ...baseRef.accounts,
    ...(['CREDO_GEL:GEL', 'CREDO_USD:USD', 'CASH_GEL:GEL'] as const).map((spec) => {
      const [id, currency] = spec.split(':') as [string, string];
      return {
        id,
        name: id.startsWith('CREDO') ? 'Дебетовая карта Credo Bank' : 'Наличные лари',
        bank: id.startsWith('CREDO') ? 'Credo Bank' : 'Кошелёк',
        type: 'Карта',
        currency,
        group: 'Текущие',
        inCapital: true,
        balance: 100,
        balanceUsd: null,
      };
    }),
  ],
};

function statementRow(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    index: 1,
    postedDate: '2026-10-10',
    date: '2026-10-09',
    direction: 'out',
    amount: 27.06,
    balance: null,
    operation: 'საბარათე ოპერაცია',
    description: 'გადახდა - spar 27.06 GEL 09.10.2026',
    counterparty: '',
    counterpartyAccount: '',
    ...overrides,
  };
}

function guess(overrides: Partial<RowGuess> = {}): RowGuess {
  return {
    type: 'Расход',
    counterAccount: null,
    category: 'Food',
    subcategory: 'Groceries',
    comment: 'Spar',
    sure: true,
    ...overrides,
  };
}

describe('statement values', () => {
  it('reads amounts the way banks print them', () => {
    expect(parseMoney('1,140.84')).toBe(1140.84);
    expect(parseMoney('1 140,84')).toBe(1140.84);
    expect(parseMoney('1.140,84')).toBe(1140.84);
    expect(parseMoney(17.9)).toBe(17.9);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('—')).toBeNull();
  });

  it('takes the purchase date from a card payment description', () => {
    expect(purchaseDate('გადახდა - spar 40.30 GEL 08.10.2026')).toBe('2026-10-08');
    expect(purchaseDate('Personal Transfer, ტელ.: 555000001')).toBeNull();
    expect(purchaseDate('payment 31.02.2026')).toBeNull();
  });
});

describe('parseWorkbook (myCredo XLSX)', () => {
  it('reads the account details and every row of the real export layout', async () => {
    const file = readFileSync(new URL('./fixtures/credo-statement.xlsx', import.meta.url));
    const statement = parseWorkbook(await readWorkbook(file));

    expect(statement).toMatchObject({
      iban: 'GE00CD0000000000000001',
      currency: 'GEL',
      from: '2026-10-09',
      to: '2026-11-09',
      opening: 238.31,
      closing: 607.25,
    });
    expect(statement.rows).toHaveLength(12);
    // Booked on the 10th, paid on the 8th: the payment date wins
    expect(statement.rows[1]).toMatchObject({
      index: 2,
      postedDate: '2026-10-10',
      date: '2026-10-08',
      direction: 'out',
      amount: 40.3,
      balance: 31.77,
    });
    expect(statement.rows[4]).toMatchObject({
      direction: 'in',
      amount: 1140.84,
      date: '2026-10-12',
      counterparty: 'გიორგი ტესტი',
      counterpartyAccount: 'GE00BG0000000000000003',
    });
    expect(verifyBalances(statement)).toEqual([]);
  });

  it('refuses a workbook without an operations table', () => {
    expect(() => parseWorkbook([{ name: 'Sheet1', rows: [['hello']] }])).toThrow(
      'Не нашёл таблицу операций',
    );
  });
});

describe('verifyBalances', () => {
  const statement = (rows: StatementRow[]): Statement => ({
    holder: '',
    iban: '',
    currency: 'GEL',
    from: null,
    to: null,
    opening: 100,
    closing: 80,
    rows,
  });

  it('accepts a statement whose running balances add up', () => {
    const rows = [
      statementRow({ amount: 30, balance: 70 }),
      statementRow({ index: 2, direction: 'in', amount: 10, balance: 80 }),
    ];
    expect(verifyBalances(statement(rows))).toEqual([]);
  });

  it('points at a misread row', () => {
    const rows = [
      statementRow({ amount: 3, balance: 70 }),
      statementRow({ index: 2, direction: 'in', amount: 10, balance: 80 }),
    ];
    expect(verifyBalances(statement(rows))).toEqual([
      'Строка 1: остаток 70, а по расчёту 97',
      'Начальный остаток 100 + обороты 7 ≠ конечный 80',
    ]);
  });
});

describe('resolveAccount', () => {
  it('takes the bank from a Georgian IBAN and the currency from the statement', () => {
    const choice = resolveAccount({ iban: 'GE00CD0000000000000001', currency: 'GEL' }, ref);
    expect(choice.account).toBe('CREDO_GEL');
  });

  it('never decides by currency alone', () => {
    const choice = resolveAccount({ iban: 'GE00TB0000000000000001', currency: 'GEL' }, ref);
    expect(choice.account).toBeNull();
    expect(choice.candidates.map((a) => a.id)).toEqual(['CREDO_GEL', 'CASH_GEL']);
  });
});

describe('rowToOperation', () => {
  it('a card payment is an expense from the statement account', () => {
    const op = rowToOperation(statementRow(), guess(), 'CREDO_GEL', ref);
    expect(op).toMatchObject({
      date: '2026-10-09',
      type: 'Расход',
      account: 'CREDO_GEL',
      amount: 27.06,
      category: 'Food',
      subcategory: 'Groceries',
      comment: 'Spar',
    });
  });

  it('an incoming row the model called an expense stays an income', () => {
    const row = statementRow({ direction: 'in', amount: 10 });
    expect(rowToOperation(row, guess(), 'CREDO_GEL', ref).type).toBe('Доход');
  });

  it('money in from a ruble account leaves the ruble amount to the owner', () => {
    const row = statementRow({ direction: 'in', amount: 1140.84 });
    const op = rowToOperation(
      row,
      guess({
        type: 'Перевод',
        counterAccount: 'T_MAIN',
        category: 'Transfer',
        subcategory: 'Exchange',
      }),
      'CREDO_GEL',
      ref,
    );
    expect(op).toMatchObject({
      account: 'T_MAIN',
      amount: null,
      toAccount: 'CREDO_GEL',
      received: 1140.84,
    });
  });

  it('a conversion out leaves «Получено» open', () => {
    const row = statementRow({ amount: 313.66 });
    const op = rowToOperation(
      row,
      guess({
        type: 'Перевод',
        counterAccount: 'CREDO_USD',
        category: 'Transfer',
        subcategory: 'Exchange',
      }),
      'CREDO_GEL',
      ref,
    );
    expect(op).toMatchObject({ account: 'CREDO_GEL', toAccount: 'CREDO_USD', amount: 313.66 });
    expect(op.received).toBeNull();
  });
});

describe('planImport', () => {
  const recorded: Existing[] = [
    {
      op: {
        date: '2026-10-09',
        type: 'Расход',
        account: 'CREDO_GEL',
        amount: 27.06,
        toAccount: null,
        received: null,
        comment: 'Spar',
      },
      source: { kind: 'row', row: 592 },
    },
    {
      op: {
        date: '2026-10-12',
        type: 'Расход',
        account: 'CREDO_GEL',
        amount: 82.49,
        toAccount: null,
        received: null,
        comment: 'Бензин',
      },
      source: { kind: 'row', row: 564 },
    },
  ];
  const rows = [
    statementRow(),
    statementRow({ index: 2, amount: 8.4, date: '2026-10-10' }),
    statementRow({ index: 3, amount: 72.6, date: '2026-10-10' }),
    statementRow({ index: 4, amount: 313.66, date: '2026-10-11' }),
  ];
  const ops = [
    rowToOperation(rows[0]!, guess(), 'CREDO_GEL', ref),
    rowToOperation(
      rows[1]!,
      guess({ category: 'Transport', subcategory: 'Taxi & rideshare' }),
      'CREDO_GEL',
      ref,
    ),
    rowToOperation(rows[2]!, guess({ sure: false }), 'CREDO_GEL', ref),
    rowToOperation(
      rows[3]!,
      guess({
        type: 'Перевод',
        counterAccount: 'CREDO_USD',
        category: 'Transfer',
        subcategory: 'Exchange',
      }),
      'CREDO_GEL',
      ref,
    ),
  ];

  it('sorts rows into recorded, ready and doubtful', () => {
    const { items, matched } = planImport(rows, ops, [true, true, false, true], recorded, ref);
    expect(items.map((i) => i.status)).toEqual(['recorded', 'ready', 'doubtful', 'doubtful']);
    expect(items[0]?.duplicate).toContain('строка 592');
    expect([...matched]).toEqual([592]);
  });

  it('lists sheet operations of the account the statement does not have', () => {
    const { matched } = planImport(rows, ops, [true, true, true, true], recorded, ref);
    const missing = missingFromStatement(recorded, matched, 'CREDO_GEL', {
      from: '2026-10-09',
      to: '2026-10-11',
    });
    expect(missing).toEqual([]);
    const wider = missingFromStatement(recorded, matched, 'CREDO_GEL', {
      from: '2026-10-09',
      to: '2026-10-12',
    });
    expect(wider.map((m) => m.source)).toEqual([{ kind: 'row', row: 564 }]);
  });

  it('knows how each operation moves the account balance', () => {
    expect(effectOn(ops[0]!, 'CREDO_GEL')).toBe(-27.06);
    expect(effectOn(ops[3]!, 'CREDO_GEL')).toBe(-313.66);
    expect(effectOn({ ...ops[3]!, received: 115 }, 'CREDO_USD')).toBe(115);
  });
});

describe('bookingHistory', () => {
  const txn = (comment: string, extra: Partial<Txn> = {}): Txn => ({
    date: '2026-10-01',
    month: '2026-10',
    type: 'Расход',
    account: 'CREDO_GEL',
    toAccount: '',
    amount: 1,
    currency: 'GEL',
    usd: 1,
    rub: 1,
    category: 'Food',
    subcategory: 'Groceries',
    comment,
    oneOff: false,
    ...extra,
  });

  it('newest first, one line per comment, only this account', () => {
    const lines = bookingHistory(
      [
        txn('Spar'),
        txn('Agrohub'),
        txn('spar'),
        txn('Taxi', { account: 'T_MAIN' }),
        txn(''),
        txn('Обмен', {
          type: 'Перевод',
          toAccount: 'CREDO_USD',
          category: 'Transfer',
          subcategory: 'Exchange',
        }),
      ],
      'CREDO_GEL',
    );
    expect(lines).toEqual([
      'Обмен → Перевод (CREDO_GEL → CREDO_USD) · Transfer / Exchange',
      'spar → Расход · Food / Groceries',
      'Agrohub → Расход · Food / Groceries',
    ]);
  });
});

describe('planImport with a wrong guess of the other account', () => {
  it('still finds the transfer the owner booked from another account, as a possible repeat', () => {
    const row = statementRow({ direction: 'in', amount: 870, date: '2026-10-23' });
    const recorded: Existing[] = [
      {
        op: {
          date: '2026-10-23',
          type: 'Перевод',
          account: 'T_MAIN',
          amount: 29486.19,
          toAccount: 'CREDO_GEL',
          received: 870,
          comment: 'перевод себе',
        },
        source: { kind: 'row', row: 525 },
      },
    ];
    const guessed = guess({
      type: 'Перевод',
      counterAccount: 'BYBIT_USDT',
      category: 'Transfer',
      subcategory: 'Crypto',
    });
    const op = rowToOperation(row, guessed, 'CREDO_GEL', ref);
    const { items, matched } = planImport([row], [op], [true], recorded, ref);
    expect(items[0]).toMatchObject({
      status: 'doubtful',
      duplicate: expect.stringContaining('строка 525'),
    });
    expect([...matched]).toEqual([525]);
  });
});

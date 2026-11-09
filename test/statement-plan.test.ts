import { describe, expect, it } from 'vitest';
import type { Txn } from '../src/analytics/dataset.js';
import type { Existing } from '../src/domain/duplicates.js';
import { bookingHistory } from '../src/statement/history.js';
import {
  effectOn,
  missingFromStatement,
  planImport,
  rowToOperation,
  type Booked,
} from '../src/statement/plan.js';
import { guess, ref, statementRow } from './statement-helpers.js';

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
const book = (sure: boolean[]): Booked[] =>
  rows.map((row, i) => ({ row, op: ops[i]!, sure: sure[i]! }));
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

describe('planImport', () => {
  it('sorts rows into recorded, ready and doubtful', () => {
    const { items, matched } = planImport(book([true, true, false, true]), recorded, ref);
    expect(items.map((i) => i.status)).toEqual(['recorded', 'ready', 'doubtful', 'doubtful']);
    expect(items[0]?.duplicate).toContain('строка 592');
    expect([...matched]).toEqual([592]);
  });

  it('lists sheet operations of the account the statement does not have', () => {
    const { matched } = planImport(book([true, true, true, true]), recorded, ref);
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
    const { items, matched } = planImport([{ row, op, sure: true }], recorded, ref);
    expect(items[0]).toMatchObject({
      status: 'doubtful',
      duplicate: expect.stringContaining('строка 525'),
    });
    expect([...matched]).toEqual([525]);
  });
});

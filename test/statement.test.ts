import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { resolveAccount } from '../src/statement/account.js';
import { rowToOperation } from '../src/statement/plan.js';
import {
  parseMoney,
  purchaseDate,
  verifyBalances,
  type Statement,
  type StatementRow,
} from '../src/statement/statement.js';
import { parseWorkbook, readWorkbook } from '../src/statement/xlsx.js';
import { guess, ref, statementRow } from './statement-helpers.js';

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

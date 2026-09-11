import { describe, expect, it } from 'vitest';
import { normalizeOperation, rowMatches, toRow, validate } from '../src/domain/operation.js';
import { expense, ref } from './fixtures.js';

const SERIAL_2026_09_11 = (Date.UTC(2026, 8, 11) - Date.UTC(1899, 11, 30)) / 86_400_000;

describe('toRow', () => {
  it('maps an operation to columns A:K', () => {
    expect(toRow(expense())).toEqual([
      '2026-09-11',
      'Расход',
      'T_MAIN',
      300,
      '',
      '',
      'Food',
      'Cafes & coffee',
      'кофе',
      false,
      '',
    ]);
  });

  it('keeps formula-like text as text', () => {
    expect(toRow(expense({ comment: '=SUM(A1)' }))[8]).toBe("'=SUM(A1)");
    expect(toRow(expense({ comment: '-' }))[8]).toBe("'-");
  });

  it('refuses incomplete operations', () => {
    expect(() => toRow(expense({ account: null }))).toThrow();
  });
});

describe('validate', () => {
  it('accepts a complete expense', () => {
    expect(validate(expense(), ref)).toEqual([]);
  });

  it('asks for a missing account instead of guessing', () => {
    expect(validate(expense({ account: null }), ref)).toContain('Не выбран счёт');
  });

  it('rejects archived accounts', () => {
    expect(validate(expense({ account: 'ARCHIVE' }), ref)).toContain('Счёт ARCHIVE архивный');
  });

  it('requires the received amount for cross-currency transfers', () => {
    const transfer = expense({
      type: 'Перевод',
      toAccount: 'BYBIT_USDT',
      amount: 10000,
      category: 'Transfer',
      subcategory: 'Exchange',
    });
    expect(validate(transfer, ref).join()).toContain('BYBIT_USDT в USDT');
    expect(validate({ ...transfer, received: 110 }, ref)).toEqual([]);
  });

  it('does not require received when currencies match', () => {
    const transfer = expense({
      type: 'Перевод',
      toAccount: 'ALFA_MAIN',
      category: 'Transfer',
      subcategory: 'Between accounts',
    });
    expect(validate(transfer, ref)).toEqual([]);
    expect(validate({ ...transfer, toAccount: 'T_MAIN' }, ref)).toContain(
      'Счета отправления и получения совпадают',
    );
  });

  it('checks the subcategory belongs to the category', () => {
    expect(validate(expense({ subcategory: 'Salary' }), ref).join()).toContain(
      'Подкатегории Salary',
    );
    expect(validate(expense({ subcategory: null }), ref)).toContain('Не выбрана подкатегория');
    expect(validate(expense({ category: 'Misc', subcategory: null }), ref)).toEqual([]);
  });

  it('flags an amount named in another currency', () => {
    expect(validate(expense({ mentionedCurrency: 'USD' }), ref).join()).toContain(
      'Сумма названа в USD',
    );
    expect(validate(expense({ mentionedCurrency: 'RUB' }), ref)).toEqual([]);
    expect(validate(expense({ account: 'BYBIT_USDT', mentionedCurrency: 'USD' }), ref)).toEqual([]);
  });
});

describe('normalizeOperation', () => {
  it('drops transfer fields from non-transfers', () => {
    const op = normalizeOperation(expense({ toAccount: 'ALFA_MAIN', received: 5 }), ref);
    expect(op.toAccount).toBeNull();
    expect(op.received).toBeNull();
  });

  it('defaults transfers to the Transfer category', () => {
    const op = normalizeOperation(
      expense({ type: 'Перевод', category: null, subcategory: null }),
      ref,
    );
    expect(op.category).toBe('Transfer');
  });

  it('clears the Transfer category when the type changes away from transfer', () => {
    const op = normalizeOperation(expense({ category: 'Transfer', subcategory: 'Exchange' }), ref);
    expect(op.category).toBeNull();
    expect(op.subcategory).toBeNull();
  });
});

describe('rowMatches', () => {
  const written = toRow(expense());

  it('matches the row read back with UNFORMATTED_VALUE', () => {
    const actual = [
      SERIAL_2026_09_11,
      'Расход',
      'T_MAIN',
      300,
      '',
      '',
      'Food',
      'Cafes & coffee',
      'кофе',
      false,
    ];
    expect(rowMatches(written, actual)).toBe(true);
    expect(rowMatches(written, [...actual.slice(0, 3), 301, ...actual.slice(4)])).toBe(false);
  });

  it('ignores the text-forcing apostrophe', () => {
    const row = toRow(expense({ comment: '=x' }));
    const actual = [
      SERIAL_2026_09_11,
      'Расход',
      'T_MAIN',
      300,
      '',
      '',
      'Food',
      'Cafes & coffee',
      '=x',
    ];
    expect(rowMatches(row, actual)).toBe(true);
  });
});

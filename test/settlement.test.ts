import { describe, expect, it } from 'vitest';
import { settlementHint } from '../src/domain/balance.js';
import { validate } from '../src/domain/operation.js';
import { activeSettlements, type Account, type Reference } from '../src/domain/reference.js';
import { toSettlement } from '../src/domain/settlement.js';
import { expense, ref as base } from './fixtures.js';

const liza: Account = {
  id: 'LIZA_GEL',
  name: 'Расчёты с Лизой',
  bank: '—',
  type: 'Расчёты',
  currency: 'GEL',
  group: 'Расчёты',
  inCapital: true,
  balance: 0,
  balanceUsd: 0,
};
const debtsRub: Account = { ...liza, id: 'DEBTS_RUB', currency: 'RUB' };
const ref: Reference = {
  accounts: [...base.accounts, liza, debtsRub],
  categories: base.categories.map((c) =>
    c.name === 'Transfer' ? { ...c, subcategories: [...c.subcategories, 'Settlement'] } : c,
  ),
};

describe('toSettlement', () => {
  it('turns an expense into a transfer to the settlement account, keeping the rest', () => {
    const op = toSettlement(expense({ comment: 'такси Лизе' }), debtsRub, ref);
    expect(op).toMatchObject({
      type: 'Перевод',
      account: 'T_MAIN',
      toAccount: 'DEBTS_RUB',
      amount: 300,
      received: null,
      category: 'Transfer',
      subcategory: 'Settlement',
      comment: 'такси Лизе',
      date: '2026-09-11',
    });
    expect(validate(op!, ref)).toEqual([]);
  });

  it('turns an income into a transfer from the settlement account', () => {
    const op = toSettlement(expense({ type: 'Доход' }), debtsRub, ref);
    expect(op).toMatchObject({ account: 'DEBTS_RUB', toAccount: 'T_MAIN', amount: 300 });
  });

  it('leaves «received» to be asked when currencies differ', () => {
    const out = toSettlement(expense(), liza, ref)!;
    expect(out.received).toBeNull();
    expect(validate(out, ref).join()).toContain('сколько пришло');
    // Income: the typed amount was in the receiving account's currency
    const income = toSettlement(expense({ type: 'Доход' }), liza, ref)!;
    expect(income).toMatchObject({ amount: null, received: 300, account: 'LIZA_GEL' });
  });

  it('uses plain Transfer when there is no Settlement subcategory, and ignores transfers', () => {
    const op = toSettlement(expense(), debtsRub, base);
    expect(op).toMatchObject({ category: 'Transfer', subcategory: null });
    expect(toSettlement({ ...expense(), type: 'Перевод' }, debtsRub, ref)).toBeNull();
  });
});

describe('settlements in reference and balance', () => {
  it('lists only active settlement accounts', () => {
    expect(activeSettlements(ref).map((a) => a.id)).toEqual(['LIZA_GEL', 'DEBTS_RUB']);
  });

  it('hints who owes whom only for settlement accounts', () => {
    expect(settlementHint({ ...liza, balance: 50 })).toBe('должны тебе');
    expect(settlementHint({ ...liza, balance: -50 })).toBe('ты должен');
    expect(settlementHint(liza)).toBe('в расчёте');
    expect(settlementHint({ ...liza, type: 'Карта', balance: 50 })).toBe('');
  });
});

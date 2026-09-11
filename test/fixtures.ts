import { blankOperation, type Operation } from '../src/domain/operation.js';
import type { Account, Reference } from '../src/domain/reference.js';

export const TZ = 'Europe/Moscow';

function account(id: string, currency: string, extra: Partial<Account> = {}): Account {
  return {
    id,
    name: `${id} name`,
    bank: 'Bank',
    type: 'Карта',
    currency,
    group: 'Текущие',
    inCapital: true,
    balance: null,
    balanceUsd: null,
    ...extra,
  };
}

export const ref: Reference = {
  accounts: [
    account('T_MAIN', 'RUB'),
    account('ALFA_MAIN', 'RUB'),
    account('HEL_MAIN', 'USD'),
    account('BYBIT_USDT', 'USDT', { type: 'Крипта', group: 'Крипта' }),
    account('ARCHIVE', 'RUB', { type: 'Архив', group: 'Архив', inCapital: false }),
  ],
  categories: [
    { name: 'Income', subcategories: ['Salary', 'Other'] },
    { name: 'Food', subcategories: ['Groceries', 'Cafes & coffee'] },
    { name: 'Transport', subcategories: ['Taxi & rideshare'] },
    { name: 'Transfer', subcategories: ['Between accounts', 'Exchange', 'Crypto'] },
    { name: 'Misc', subcategories: [] },
  ],
};

export function expense(overrides: Partial<Operation> = {}): Operation {
  return {
    ...blankOperation('2026-09-11'),
    account: 'T_MAIN',
    amount: 300,
    category: 'Food',
    subcategory: 'Cafes & coffee',
    comment: 'кофе',
    ...overrides,
  };
}

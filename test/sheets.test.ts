import { describe, expect, it } from 'vitest';
import { findFreeRow, locateRow } from '../src/sheets/operations.js';
import { parseAccounts, parseCategories } from '../src/sheets/reference.js';
import { compareHeaders, EXPECTED_HEADERS } from '../src/sheets/schema-check.js';

describe('findFreeRow', () => {
  it('appends after the last filled row', () => {
    expect(findFreeRow([['Дата'], [46000], [46001]])).toBe(4);
  });

  it('reuses a gap left by undo', () => {
    expect(findFreeRow([['Дата'], [46000], [], [46002]])).toBe(3);
    expect(findFreeRow([['Дата'], [46000], [''], [46002]])).toBe(3);
  });

  it('starts right below the header', () => {
    expect(findFreeRow([['Дата']])).toBe(2);
    expect(findFreeRow([])).toBe(2);
  });
});

describe('locateRow', () => {
  const header = ['Дата', 'Тип'];
  const coffee = [
    46276,
    'Расход',
    'T_MAIN',
    300,
    '',
    '',
    'Food',
    'Groceries',
    'кофе',
    false,
    '',
    46277.5,
  ];
  const taxi = [
    46275,
    'Расход',
    'T_MAIN',
    500,
    '',
    '',
    'Transport',
    'Taxi',
    'такси',
    false,
    '',
    46277.6,
  ];
  const written = ['2026-09-11', ...coffee.slice(1)] as (string | number | boolean)[];

  it('prefers the row saved at write time', () => {
    expect(locateRow([header, taxi, coffee], 3, written)).toEqual({ status: 'found', row: 3 });
  });

  it('follows the row after the sheet was sorted', () => {
    expect(locateRow([header, coffee, taxi], 3, written)).toEqual({ status: 'found', row: 2 });
  });

  it('does not guess between identical rows', () => {
    expect(locateRow([header, coffee, taxi, coffee], 3, written)).toEqual({ status: 'changed' });
  });

  it('reports a row edited by hand', () => {
    const edited = [...coffee.slice(0, 3), 350, ...coffee.slice(4)];
    expect(locateRow([header, taxi, edited], 3, written)).toEqual({ status: 'changed' });
  });

  it('reports a row that is already empty', () => {
    expect(locateRow([header, taxi, []], 3, written)).toEqual({ status: 'empty' });
    expect(locateRow([header, taxi], 3, written)).toEqual({ status: 'empty' });
  });
});

describe('parseAccounts', () => {
  it('reads A:K and skips empty rows', () => {
    const rows = [
      [
        'T_MAIN',
        'Дебетовая карта',
        'T-Bank',
        'Карта',
        'rub',
        'Текущие',
        true,
        100,
        '',
        12345.6,
        140.2,
      ],
      [],
      ['CASH_RUB', 'Наличные', '', 'Наличные', 'RUB', 'Текущие', false],
    ];
    expect(parseAccounts(rows)).toEqual([
      {
        id: 'T_MAIN',
        name: 'Дебетовая карта',
        bank: 'T-Bank',
        type: 'Карта',
        currency: 'RUB',
        group: 'Текущие',
        inCapital: true,
        balance: 12345.6,
        balanceUsd: 140.2,
      },
      {
        id: 'CASH_RUB',
        name: 'Наличные',
        bank: '',
        type: 'Наличные',
        currency: 'RUB',
        group: 'Текущие',
        inCapital: false,
        balance: null,
        balanceUsd: null,
      },
    ]);
  });
});

describe('parseCategories', () => {
  it('reads per-category columns until CategoryList', () => {
    const rows = [
      ['Income', 'Food', 'Other', 'CategoryList', 'Junk'],
      ['Salary', 'Groceries', 'Misc', 'Income', 'x'],
      ['Bonus', 'Groceries', '', 'Food'],
      ['', 'Delivery'],
    ];
    expect(parseCategories(rows)).toEqual([
      { name: 'Income', subcategories: ['Salary', 'Bonus'] },
      { name: 'Food', subcategories: ['Groceries', 'Delivery'] },
      { name: 'Other', subcategories: ['Misc'] },
    ]);
  });

  it('skips the blank spacer column before the categories (live layout: C empty, D:S)', () => {
    const rows = [
      ['', 'Income', 'Food', 'CategoryList'],
      ['', 'Salary', 'Groceries', 'Income'],
    ];
    expect(parseCategories(rows)).toEqual([
      { name: 'Income', subcategories: ['Salary'] },
      { name: 'Food', subcategories: ['Groceries'] },
    ]);
  });
});

describe('compareHeaders', () => {
  it('accepts the expected header, tolerating ё/е and spacing', () => {
    expect(compareHeaders(EXPECTED_HEADERS)).toEqual([]);
    const loose = EXPECTED_HEADERS.map((h) => h.replace('ё', 'е').toUpperCase());
    expect(compareHeaders(loose)).toEqual([]);
  });

  it('reports shifted columns', () => {
    const shifted = ['Дата', 'Тип', 'Сумма', ...EXPECTED_HEADERS.slice(3)];
    expect(compareHeaders(shifted)).toEqual(['C1: ожидалось «Счёт», в таблице «Сумма»']);
  });
});

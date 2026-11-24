import { describe, expect, it } from 'vitest';
import {
  categoryFormula,
  isCategoriesDone,
  missingPairs,
  planAccounts,
  planCategories,
  planListRule,
  planRowInsert,
  sumCovers,
} from '../src/sheets/settlements-plan.js';

const header = (n: number, list = 'CategoryList') => [
  'Category',
  'Subcategory',
  '',
  ...Array.from({ length: n }, (_, i) => (i === 0 ? '=TRANSPOSE(...)' : '')),
  list,
];

describe('planCategories', () => {
  const grid = [
    header(2),
    ['Income', 'Salary', '', 'old', 'old', 'Income'],
    ['Liza', 'Gifts', '', 'old', 'old', 'Liza'],
  ];

  it('appends pairs, inserts columns for the new category and rewrites formulas', () => {
    const plan = planCategories(grid);
    expect(plan.firstFreeRow).toBe(4);
    expect(plan.newPairs).toContainEqual(['Projects', 'Ads']);
    expect(plan.categoryCount).toBe(4); // Income, Liza, Projects, Transfer
    expect(plan.insertColumns).toBe(2);
    expect(plan.formulaCols).toEqual([3, 7]);
    expect(plan.rewriteFormulas).toBe(true);
    expect(plan.listAppend.names).toEqual(['Projects', 'Transfer']);
  });

  it('is a no-op once the sheet is in the target state', () => {
    const pairs = [
      ['Income', 'Salary'],
      ['Liza', 'Gifts'],
      ...planCategories(grid).newPairs.map((p) => [...p]),
    ];
    const done = [
      [...header(4)],
      ...pairs.map((p, i) => [...p, '', ...(i === 0 ? [3, 4, 5, 6].map(categoryFormula) : [])]),
    ];
    // static category list in the column after the four category columns
    const names = ['Income', 'Liza', 'Projects', 'Transfer'];
    names.forEach((n, i) => {
      done[i + 1] = [
        ...(done[i + 1] ?? []),
        ...Array(Math.max(0, 7 - (done[i + 1]?.length ?? 0))),
        n,
      ];
    });
    expect(isCategoriesDone(planCategories(done))).toBe(true);
  });

  it('lists flat pairs the category columns do not show', () => {
    const flat = [
      ['Category', 'Subcategory'],
      ['Income', 'Cashback'],
      ['Income', 'Salary'],
    ];
    const columns = [
      ['', 'Income'],
      ['', 'Salary'],
    ].map((r) => r.slice(1));
    expect(missingPairs(flat, [['Income'], ['Salary']])).toEqual(['Income / Cashback']);
    expect(columns.length).toBe(2);
  });
});

describe('planAccounts', () => {
  it('uses the first empty rows and skips existing IDs', () => {
    const rows = [['ID'], ['T_MAIN'], ['LIZA_GEL'], [''], ['']];
    const plan = planAccounts(rows);
    expect(plan.map((p) => [p.row, p.account.id])).toEqual([
      [4, 'DEBTS_RUB'],
      [5, 'DEBTS_GEL'],
    ]);
    expect(plan[0]?.account.values[3]).toBe('Расчёты');
  });
});

describe('list rules and row inserts', () => {
  const rule = (values: string[]) => ({
    condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
    strict: true,
  });

  it('adds a value to the rule, keeping strictness, and is idempotent', () => {
    const rules = [undefined, rule(['a', 'b']), rule(['a', 'b'])];
    const plan = planListRule(rules, 'c', 5);
    expect(plan?.rule.strict).toBe(true);
    expect(plan?.rule.condition?.values?.map((v) => v.userEnteredValue)).toEqual(['a', 'b', 'c']);
    expect(plan?.endRow).toBe(5);
    const after = [undefined, ...Array(4).fill(plan?.rule)];
    expect(planListRule(after, 'c', 5)).toBeNull();
  });

  it('finds the insert position before a label and notices it is done', () => {
    const column = [['Кат'], ['Housing'], ['Other']];
    expect(planRowInsert(column, 'Other', 'Projects')).toEqual({ kind: 'insert', index: 2 });
    expect(planRowInsert([...column, ['Projects']], 'Other', 'Projects').kind).toBe('done');
    expect(planRowInsert(column, 'Nope', 'Projects').kind).toBe('missing');
  });

  it('checks that a SUM covers the inserted row', () => {
    expect(sumCovers('=SUM(B5:B12)', 11)).toBe(true);
    expect(sumCovers('=SUM(B5:B11)', 12)).toBe(false);
  });
});

import type { sheets_v4 } from 'googleapis';
import { isoToSerial } from '../domain/dates.js';
import { parseCategories } from './reference.js';
import { columnLetter } from './weeks-layout.js';

/** Pure planning for scripts/setup-settlements.ts: what is missing in the sheet and where. */
export type Grid = unknown[][];

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim();

export const CATEGORIES_SHEET = 'Categories';
const CATEGORY_LIST_HEADER = 'categorylist';
const FIRST_CATEGORY_COL = 3; // D: the flat A/B pairs, a spacer C, then one column per category

export const NEW_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['Liza', 'Allowance'],
  ['Liza', 'Health'],
  ['Liza', 'Beauty & care'],
  ['Liza', 'Clothing'],
  ['Projects', 'Ads'],
  ['Projects', 'Hosting & servers'],
  ['Projects', 'Domains'],
  ['Projects', 'AI & APIs'],
  ['Projects', 'Tools & services'],
  ['Projects', 'Contractors'],
  ['Projects', 'Other'],
  ['Income', 'Projects'],
  ['Transfer', 'Settlement'],
];

/** One spilling formula per category column replaces the old fixed-height per-row ones. */
export function categoryFormula(col: number): string {
  return `=IFERROR(FILTER($B$2:$B,$A$2:$A=${columnLetter(col)}$1,$B$2:$B<>""),"")`;
}

export interface CategoriesPlan {
  firstFreeRow: number; // 1-based, where the new pairs start
  newPairs: Array<readonly [string, string]>;
  categoryCount: number;
  listCol: number; // 0-based column of «CategoryList» before the insert
  insertColumns: number;
  /** Category columns [from, to) after the insert. */
  formulaCols: [number, number];
  rewriteFormulas: boolean;
  listAppend: { row: number; names: string[] }; // row is 1-based
}

function withInserted(grid: Grid, at: number, count: number): Grid {
  return grid.map((row) => {
    const padded = [...row, ...Array(Math.max(0, at - row.length)).fill('')];
    return [...padded.slice(0, at), ...Array(count).fill(''), ...padded.slice(at)];
  });
}

/** `grid` is Categories!A1:AZ as formulas, so spilled cells read as empty. */
export function planCategories(grid: Grid): CategoriesPlan {
  const header = grid[0] ?? [];
  const listCol = header.findIndex((v) => text(v).toLowerCase() === CATEGORY_LIST_HEADER);
  if (listCol === -1) throw new Error('В Categories не найден столбец «CategoryList» в строке 1');

  let lastRow = 0;
  const known = new Set<string>();
  const names = new Set<string>();
  grid.forEach((row, i) => {
    if (i === 0 || !text(row[0])) return;
    lastRow = i;
    known.add(`${text(row[0])}|${text(row[1])}`);
    names.add(text(row[0]));
  });
  const newPairs = NEW_PAIRS.filter(([c, s]) => !known.has(`${c}|${s}`));
  for (const [c] of newPairs) names.add(c);

  const insertColumns = Math.max(0, names.size - (listCol - FIRST_CATEGORY_COL));
  const newList = listCol + insertColumns;
  const rows = withInserted(grid, listCol, insertColumns);
  let rewriteFormulas = false;
  for (let col = FIRST_CATEGORY_COL; col < newList; col++) {
    if (text(rows[1]?.[col]) !== categoryFormula(col)) rewriteFormulas = true;
    if (rows.slice(2).some((row) => text(row[col]) !== '')) rewriteFormulas = true;
  }

  const listed = rows.slice(1).map((row) => text(row[newList]));
  const lastListed = listed.reduce((last, v, i) => (v ? i : last), -1);
  const missing = [...names].filter((n) => !listed.includes(n));
  return {
    firstFreeRow: lastRow + 2,
    newPairs,
    categoryCount: names.size,
    listCol,
    insertColumns,
    formulaCols: [FIRST_CATEGORY_COL, newList],
    rewriteFormulas,
    listAppend: { row: lastListed + 3, names: missing },
  };
}

export const isCategoriesDone = (plan: CategoriesPlan): boolean =>
  plan.newPairs.length === 0 &&
  plan.insertColumns === 0 &&
  !plan.rewriteFormulas &&
  plan.listAppend.names.length === 0;

/** Flat A/B pairs that the per-category columns (what the bot reads) do not show. */
export function missingPairs(flat: Grid, columnsRange: Grid): string[] {
  const shown = new Map(parseCategories(columnsRange).map((c) => [c.name, c.subcategories]));
  const missing = new Set<string>();
  for (const row of flat.slice(1)) {
    const [category, sub] = [text(row[0]), text(row[1])];
    if (category && sub && !shown.get(category)?.includes(sub)) missing.add(`${category} / ${sub}`);
  }
  return [...missing];
}

export interface NewAccount {
  id: string;
  /** Columns A:I. */
  values: Array<string | number | boolean>;
  note: string; // L
}

const SETTLED = 'Расчёты';
const START = isoToSerial('2026-09-01');
const account = (id: string, name: string, currency: string, note: string): NewAccount => ({
  id,
  values: [id, name, '—', SETTLED, currency, SETTLED, true, 0, START],
  note,
});

export const NEW_ACCOUNTS: NewAccount[] = [
  account('LIZA_GEL', 'Расчёты с Лизой', 'GEL', 'Плюс — Лиза должна мне, минус — я ей'),
  account(
    'DEBTS_RUB',
    'Долги людей (₽)',
    'RUB',
    'Плюс — мне должны, минус — я должен. Кто — в комментарии операции',
  ),
  account(
    'DEBTS_GEL',
    'Долги людей (₾)',
    'GEL',
    'Плюс — мне должны, минус — я должен. Кто — в комментарии операции',
  ),
];

/** The new accounts that are not in «Счета» yet, each with the first free row (1-based). */
export function planAccounts(rows: Grid): Array<{ row: number; account: NewAccount }> {
  const ids = new Set(rows.slice(1).map((r) => text(r[0])));
  const missing = NEW_ACCOUNTS.filter((a) => !ids.has(a.id));
  const plan: Array<{ row: number; account: NewAccount }> = [];
  for (let i = 1; i < 1000 && plan.length < missing.length; i++) {
    if (text(rows[i]?.[0]) === '') plan.push({ row: i + 1, account: missing[plan.length]! });
  }
  return plan;
}

type Rule = sheets_v4.Schema$DataValidationRule;
export interface ListRulePlan {
  startRow: number; // 0-based
  endRow: number; // exclusive
  rule: Rule;
}

const listValues = (rule: Rule | null | undefined): string[] =>
  rule?.condition?.type === 'ONE_OF_LIST'
    ? (rule.condition.values ?? []).map((v) => v.userEnteredValue ?? '')
    : [];

/** Adds `value` to the dropdown of a column; `rules[i]` is the rule of row index i (0 = header). */
export function planListRule(rules: Array<Rule | null | undefined>, value: string, minEnd: number) {
  const ruled = rules.map((r, i) => (listValues(r).length > 0 ? i : -1)).filter((i) => i > 0);
  const first = ruled[0];
  if (first === undefined) throw new Error('В столбце нет выпадающего списка — нечего расширять');
  const end = Math.max((ruled.at(-1) ?? 0) + 1, minEnd);
  const covered = Array.from({ length: end - 1 }, (_, i) => rules[i + 1]).every((r) =>
    listValues(r).includes(value),
  );
  if (covered) return null;

  const base = rules[first]!;
  const values = listValues(base);
  const next = values.includes(value) ? values : [...values, value];
  const rule: Rule = {
    ...base,
    condition: { ...base.condition, values: next.map((v) => ({ userEnteredValue: v })) },
  };
  return { startRow: 1, endRow: end, rule } satisfies ListRulePlan;
}

export type InsertPlan = { kind: 'done' } | { kind: 'missing' } | { kind: 'insert'; index: number };

/** Insert a row with `add` right before the row labelled `before` (0-based `index`). */
export function planRowInsert(columnA: Grid, before: string, add: string): InsertPlan {
  const labels = columnA.map((r) => text(r[0]));
  if (labels.includes(add)) return { kind: 'done' };
  const index = labels.indexOf(before, 1);
  return index === -1 ? { kind: 'missing' } : { kind: 'insert', index };
}

/** Whether `=SUM(B5:B12)`-like formula covers `row` (1-based). */
export function sumCovers(formula: string, row: number): boolean {
  const match = /SUM\(\$?[A-Z]+\$?(\d+):\$?[A-Z]+\$?(\d+)\)/.exec(formula);
  return match !== null && Number(match[1]) <= row && row <= Number(match[2]);
}

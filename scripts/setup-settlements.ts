/**
 * One-off migration for settlements with people, Liza's subcategories and the Projects category
 * (docs/SHEET_V2.md §3, §4, §10). Never touches «Операции» data; idempotent.
 *
 * Usage: yarn settlements-sheet [--apply] [--live]
 *   without --apply — dry run: reads the sheet, prints the plan, writes nothing;
 *   --apply — runs the steps A1..A5 (each is one batchUpdate), then verifies by re-reading;
 *   --live — required with --apply when the spreadsheet is the default (live) one.
 * Before --apply the operator runs `yarn backup-sheet`. SPREADSHEET_ID=<copy> picks another file.
 */
import type { sheets_v4 } from 'googleapis';
import { envSchema } from '../src/config/env.js';
import { initSheets } from '../src/sheets/client.js';
import { OPERATIONS_SHEET } from '../src/sheets/operations.js';
import {
  accountRequests,
  categoriesRequests,
  insertRowRequests,
  listRuleRequest,
} from '../src/sheets/settlements-requests.js';
import {
  isCategoriesDone,
  longestList,
  missingPairs,
  planAccounts,
  planCategories,
  planListRule,
  planRowInsert,
  sumCovers,
  type Grid,
} from '../src/sheets/settlements-plan.js';
import { buildSubsStep } from './settlements-subs.js';

const FLAGS = ['--apply', '--live'];
const args = process.argv.slice(2);
const unknown = args.filter((arg) => !FLAGS.includes(arg));
if (unknown.length > 0) fail(`Неизвестные флаги: ${unknown.join(' ')}`);
const has = (flag: string) => args.includes(flag);

const env = envSchema
  .pick({ GOOGLE_SERVICE_ACCOUNT_EMAIL: true, GOOGLE_PRIVATE_KEY: true, SPREADSHEET_ID: true })
  .parse(process.env);
const sheets = initSheets(env);
const spreadsheetId = env.SPREADSHEET_ID;
const isLive = spreadsheetId === envSchema.shape.SPREADSHEET_ID.parse(undefined);

type Request = sheets_v4.Schema$Request;
export interface Step {
  name: string;
  /** Empty when there is nothing to do. */
  lines: string[];
  requests: Request[];
  /** Problems found when re-reading after apply; empty = OK. */
  verify: () => Promise<string[]>;
}

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function read(range: string, render = 'UNFORMATTED_VALUE'): Promise<Grid> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: render,
  });
  return (response.data.values ?? []) as Grid;
}

type Rule = sheets_v4.Schema$DataValidationRule;
/** Validation rules of a range, one array per column, index = row offset. */
async function readRules(range: string, columns: number): Promise<Array<Array<Rule | undefined>>> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [range],
    fields: 'sheets.data.rowData.values.dataValidation',
  });
  const rows = response.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
  return Array.from({ length: columns }, (_, c) =>
    rows.map((row) => row.values?.[c]?.dataValidation ?? undefined),
  );
}

export interface SheetInfo {
  sheetId: number;
  title: string;
  rows: number;
  columns: number;
}
async function listSheets(): Promise<SheetInfo[]> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties)',
  });
  return (meta.data.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? -1,
    title: s.properties?.title ?? '',
    rows: s.properties?.gridProperties?.rowCount ?? 0,
    columns: s.properties?.gridProperties?.columnCount ?? 0,
  }));
}

const retry = async (check: () => Promise<string[]>): Promise<string[]> => {
  let problems: string[] = ['не читалось'];
  for (let attempt = 1; attempt <= 6 && problems.length > 0; attempt++) {
    if (attempt > 1) await sleep(5000);
    problems = await check();
  }
  return problems;
};

const ctx = { read, readRules, retry };
export type Ctx = typeof ctx;

type Sheets = Map<string, SheetInfo>;
const need = (all: Sheets, title: string): SheetInfo =>
  all.get(title) ?? fail(`Нет листа «${title}»`);

async function categoriesStep(all: Sheets): Promise<Step> {
  const sheet = need(all, 'Categories');
  const grid = await read('Categories!A1:AZ', 'FORMULA');
  const plan = planCategories(grid);
  const lines: string[] = [];
  if (!isCategoriesDone(plan)) {
    lines.push(`пар в A:B: +${plan.newPairs.length}, с строки ${plan.firstFreeRow}`);
    for (const [c, s] of plan.newPairs) lines.push(`  ${c} / ${s}`);
    lines.push(
      `категорий ${plan.categoryCount}; вставить столбцов перед CategoryList: ${plan.insertColumns}`,
    );
    if (plan.rewriteFormulas)
      lines.push('столбцы категорий: в строке 2 FILTER-формула, строки 3+ очистить');
    if (plan.listAppend.names.length > 0)
      lines.push(`CategoryList +${plan.listAppend.names.join(', ')}`);
  }
  const verify = () =>
    retry(async () => {
      const [flat, columns] = await Promise.all([
        read('Categories!A1:B'),
        read('Categories!C1:AZ'),
      ]);
      const problems = missingPairs(flat, columns).map((p) => `не видно в столбце категории: ${p}`);
      const shown = columns[0]?.filter((v) => String(v ?? '').trim() !== '').length ?? 0;
      return shown >= plan.categoryCount + 1
        ? problems
        : [...problems, `в шапке ${shown} значений`];
    });
  return {
    name: 'A1 Categories',
    lines,
    requests: lines.length ? categoriesRequests(sheet.sheetId, plan) : [],
    verify,
  };
}

async function accountsStep(all: Sheets): Promise<Step> {
  const sheet = need(all, 'Счета');
  const rows = await read('Счета!A1:L1001');
  const plan = planAccounts(rows);
  const [types, groups] = await readRules('Счета!D1:F1001', 3).then(([d, , f]) => [
    d ?? [],
    f ?? [],
  ]);
  const typeRule = planListRule(types, 'Расчёты', 1001);
  const groupRule = planListRule(groups, 'Расчёты', 1001);
  const lines = plan.map(
    ({ row, account }) => `«Счета» строка ${row}: ${account.id} (${account.values[4]})`,
  );
  if (typeRule) lines.push(`«Счета»!D (Тип): список +Расчёты на строках 2..${typeRule.endRow}`);
  if (groupRule)
    lines.push(`«Счета»!F (Группа): список +Расчёты на строках 2..${groupRule.endRow}`);
  const requests = [
    ...(typeRule ? [listRuleRequest(sheet.sheetId, 3, typeRule)] : []),
    ...(groupRule ? [listRuleRequest(sheet.sheetId, 5, groupRule)] : []),
    ...accountRequests(sheet.sheetId, plan),
  ];
  const verify = async () => {
    const after = planAccounts(await read('Счета!A1:L1001'));
    const [d, , f] = await readRules('Счета!D1:F1001', 3);
    return [
      ...(after.length > 0 ? ['счета не появились'] : []),
      ...(planListRule(d ?? [], 'Расчёты', 1001) ? ['«Расчёты» нет в списке Типа'] : []),
      ...(planListRule(f ?? [], 'Расчёты', 1001) ? ['«Расчёты» нет в списке Группы'] : []),
    ];
  };
  return { name: 'A2 Счета', lines, requests, verify };
}

async function insertStep(
  all: Sheets,
  title: string,
  name: string,
  before: string,
  add: string,
  width: number,
  check: (grid: Grid, row: number) => string[],
): Promise<Step> {
  const sheet = need(all, title);
  const range = `'${title}'!A1:A60`;
  const plan = planRowInsert(await read(range, 'FORMULA'), before, add);
  if (plan.kind === 'missing') fail(`«${title}»: нет строки «${before}» в столбце A`);
  const verify = () =>
    retry(async () => {
      const labels = await read(range, 'FORMULA');
      const row = labels.findIndex((r) => String(r[0] ?? '') === add) + 1;
      if (row === 0) return [`строки «${add}» нет`];
      return check(await read(`'${title}'!A1:AC60`, 'FORMULA'), row);
    });
  if (plan.kind === 'done') return { name, lines: [], requests: [], verify };
  const lines = [
    `«${title}»: новая строка ${plan.index + 1} («${add}») перед «${before}», формулы с предыдущей`,
  ];
  return {
    name,
    lines,
    requests: insertRowRequests(sheet.sheetId, plan.index, width, add),
    verify,
  };
}

async function buildSteps(): Promise<Step[]> {
  const all = new Map((await listSheets()).map((s) => [s.title, s]));
  const dashboard = (grid: Grid, row: number) => {
    const total = grid.find((r) => String(r[0] ?? '').startsWith('Капитал (чистый)'));
    return sumCovers(String(total?.[1] ?? ''), row)
      ? []
      : [`итог не покрывает строку ${row}: ${String(total?.[1])}`];
  };
  const monthly = (grid: Grid, row: number) =>
    String(grid[row - 1]?.[6] ?? '').includes(`$A${row}`)
      ? []
      : [`формулы строки ${row} не ссылаются на $A${row}`];
  const ops = need(all, OPERATIONS_SHEET);
  const flat = await read('Categories!A1:B');
  return [
    await categoriesStep(all),
    await accountsStep(all),
    await insertStep(all, 'Дашборд', 'A3 Дашборд', 'Кредиты', 'Расчёты', 4, dashboard),
    await insertStep(
      all,
      'Категории по месяцам',
      'A4 Категории по месяцам',
      'Other',
      'Projects',
      29,
      monthly,
    ),
    await buildSubsStep(all, ops, longestList(flat), ctx),
  ];
}

async function apply(steps: Step[]): Promise<void> {
  let failures = 0;
  for (const step of steps.filter((s) => s.requests.length > 0)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: step.requests },
    });
    console.log(`✓ ${step.name}: записано (${step.requests.length} запросов)`);
  }
  for (const step of steps) {
    const problems = await step.verify();
    failures += problems.length;
    console.log(
      problems.length === 0
        ? `✓ ${step.name}: проверено`
        : `✖ ${step.name}:\n    ${problems.slice(0, 8).join('\n    ')}`,
    );
  }
  console.log(failures === 0 ? '\nГотово.' : `\nПроблем: ${failures} — смотри выше.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  console.log(`Таблица: ${isLive ? 'ЖИВАЯ' : 'копия'} (${spreadsheetId})`);
  if (has('--apply') && isLive && !has('--live')) {
    fail('Это ЖИВАЯ таблица: для --apply добавь --live (или задай SPREADSHEET_ID копии)');
  }
  const steps = await buildSteps();
  console.log('\nПлан:');
  for (const step of steps) {
    console.log(step.lines.length === 0 ? `✓ ${step.name}: уже сделано` : `• ${step.name}`);
    for (const line of step.lines) console.log(`    ${line}`);
  }
  if (steps.every((s) => s.requests.length === 0)) {
    console.log('\nНичего делать не нужно: таблица уже в нужном состоянии.');
    return;
  }
  if (has('--apply')) return apply(steps);
  console.log('\nDry run. Перед --apply: yarn backup-sheet. Применить: --apply [--live].');
}

await main();

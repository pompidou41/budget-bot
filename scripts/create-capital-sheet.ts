/**
 * Creates the formula-only sheet «Капитал» (capital and savings at every 1/9/17/25 since the
 * accounts' «Дата начала», docs/SHEET_V2.md §9). The bot never reads or writes it.
 *
 * Usage: yarn capital-sheet [--apply] [--replace] [--live] [--check]
 *   without --apply — dry run: checks the sheet, prints the plan and the expected numbers;
 *   --apply — creates the sheet, fills and styles it, then verifies every point;
 *   --replace — with --apply: deletes the existing «Капитал» first (formulas only);
 *   --live — required with --apply when the spreadsheet is the default (live) one;
 *   --check — only verifies the existing sheet (read-only).
 * SPREADSHEET_ID=<id of a copy> picks the spreadsheet; the default is the live one.
 */
import type { sheets_v4 } from 'googleapis';
import { envSchema } from '../src/config/env.js';
import { isoToSerial, serialToIso, todayIn } from '../src/domain/dates.js';
import {
  capitalAccounts,
  checkCapital,
  cutoffPoints,
  monthAgoPoint,
  movements,
  pointAt,
  type CapitalCheck,
  type Point,
} from '../src/sheets/capital-check.js';
import { addCapitalSheet, capitalFormatRequests } from '../src/sheets/capital-format.js';
import {
  ACCOUNTS_SHEET,
  accountIndexes,
  CAPITAL_COLUMNS,
  CAPITAL_SHEET,
  cutoffsFormula,
  matrixFormula,
  NOW_CUTOFF,
  operationIndexes,
  savingsFormula,
  STEPS,
  type CapitalInput,
} from '../src/sheets/capital-layout.js';
import { capitalValues } from '../src/sheets/capital-values.js';
import { initSheets } from '../src/sheets/client.js';
import { OPERATIONS_SHEET } from '../src/sheets/operations.js';
import { columnLetter, RATES_SHEET } from '../src/sheets/weeks-layout.js';

const FLAGS = ['--apply', '--replace', '--live', '--check'];
const DASHBOARD_SHEET = 'Дашборд';
const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 5000;

const args = process.argv.slice(2);
const unknownFlags = args.filter((arg) => !FLAGS.includes(arg));
if (unknownFlags.length > 0) fail(`Неизвестные флаги: ${unknownFlags.join(' ')}`);
const has = (flag: string) => args.includes(flag);

const env = envSchema
  .pick({
    GOOGLE_SERVICE_ACCOUNT_EMAIL: true,
    GOOGLE_PRIVATE_KEY: true,
    SPREADSHEET_ID: true,
    BOT_TIMEZONE: true,
  })
  .parse(process.env);
const sheets = initSheets(env);
const spreadsheetId = env.SPREADSHEET_ID;
const isLive = spreadsheetId === envSchema.shape.SPREADSHEET_ID.parse(undefined);

type Grid = unknown[][];

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function read(range: string): Promise<Grid> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (response.data.values ?? []) as Grid;
}

async function batch(requests: sheets_v4.Schema$Request[]) {
  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
  return response.data.replies ?? [];
}

interface SheetInfo {
  sheetId: number;
  title: string;
  index: number;
}

async function listSheets(): Promise<{ title: string; sheets: SheetInfo[] }> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties(sheetId,title,index)',
  });
  return {
    title: meta.data.properties?.title ?? spreadsheetId,
    sheets: (meta.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? -1,
      title: s.properties?.title ?? '',
      index: s.properties?.index ?? 0,
    })),
  };
}

interface Sources {
  operations: Grid;
  accounts: Grid;
  rates: Grid;
}

const readSources = async (): Promise<Sources> => {
  const [operations, accounts, rates] = await Promise.all([
    read(`'${OPERATIONS_SHEET}'!A1:Z`),
    read(`'${ACCOUNTS_SHEET}'!A1:Z`),
    read(`'${RATES_SHEET}'!A1:E`),
  ]);
  return { operations, accounts, rates };
};

/** Everything the formulas depend on; exits with a clear message if the sheet isn't as expected. */
function preflight({ operations, accounts, rates }: Sources): CapitalInput {
  const ops = operationIndexes(operations[0] ?? []);
  if (!ops.ok) fail(`В шапке «${OPERATIONS_SHEET}» нет: ${ops.missing.join(', ')}`);
  const accs = accountIndexes(accounts[0] ?? []);
  if (!accs.ok) fail(`В шапке «${ACCOUNTS_SHEET}» нет: ${accs.missing.join(', ')}`);
  const rubIndex = rates.findIndex((row, i) => i >= 3 && String(row[0]).trim() === 'RUB');
  if (rubIndex === -1 || typeof rates[rubIndex]?.[4] !== 'number') {
    fail(`В «${RATES_SHEET}»!A4:E нет строки RUB с числовым курсом в E`);
  }
  return { ops: ops.indexes, accounts: accs.indexes, rubRow: rubIndex + 1 };
}

const usd = (value: number) => Math.round(value).toLocaleString('ru-RU');

function printPoints(points: Point[]): void {
  console.log('\n  Дата        Капитал  Сбережения   (USD)');
  for (const p of points) {
    const label = p.cutoff >= NOW_CUTOFF ? 'сейчас    ' : serialToIso(p.cutoff);
    console.log(`  ${label}  ${usd(p.capital).padStart(8)}  ${usd(p.savings).padStart(10)}`);
  }
}

function describePlan(input: CapitalInput, sources: Sources): void {
  const letters = (indexes: Record<string, number>) =>
    Object.entries(indexes)
      .map(([key, index]) => `${key}=${columnLetter(index)}`)
      .join(' ');
  console.log(`\n«${OPERATIONS_SHEET}»: ${letters(input.ops)}`);
  console.log(`«${ACCOUNTS_SHEET}»: ${letters(input.accounts)}`);
  console.log(`Курс RUB: «${RATES_SHEET}»!E${input.rubRow}`);
  console.log('\nОбразцы формул:');
  console.log(`  [срезы] N25\n    ${cutoffsFormula()}`);
  console.log(`  [матрица USD] P25\n    ${matrixFormula(input)}`);
  console.log(`  [сбережения] D25\n    ${savingsFormula()}`);
  const values = capitalValues(input);
  const formatting = capitalFormatRequests(0);
  console.log(
    `\nЗапросы: addSheet 1 (${CAPITAL_COLUMNS} колонок), values ${values.length} диапазонов, ` +
      `оформление ${formatting.length}`,
  );
  printExpected(sources, isoToSerial(todayIn(env.BOT_TIMEZONE)));
}

/** The numbers the sheet should show today, computed from the raw values without formulas. */
function printExpected({ operations, accounts, rates }: Sources, today: number): void {
  const included = capitalAccounts(accounts, rates);
  const ops = movements(operations);
  for (const step of STEPS) {
    console.log(`
Ожидается, шаг «${step}»:`);
    printPoints(cutoffPoints(included, today, step).map((c) => pointAt(included, ops, c)));
  }
  const monthAgo = pointAt(included, ops, monthAgoPoint(included, today));
  const now = pointAt(included, ops, NOW_CUTOFF);
  console.log(
    `
Сводка «за месяц» (с ${serialToIso(monthAgo.cutoff)}): капитал ${usd(now.capital - monthAgo.capital)}, ` +
      `сбережения ${usd(now.savings - monthAgo.savings)} USD`,
  );
}

async function verify(): Promise<number> {
  console.log('\nПроверка:');
  let result: CapitalCheck = { problems: ['не читалось'], notes: [], points: [] };
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const [sheet, sources] = await Promise.all([
      read(`'${CAPITAL_SHEET}'!A1:${columnLetter(CAPITAL_COLUMNS - 1)}`),
      readSources(),
    ]);
    result = checkCapital({ ...sources, sheet });
    if (result.problems.length === 0) break;
    if (attempt < VERIFY_ATTEMPTS) {
      console.log(`  … ещё считается (${attempt}/${VERIFY_ATTEMPTS}): ${result.problems[0]}`);
      await sleep(VERIFY_DELAY_MS);
    }
  }
  for (const note of result.notes) console.log(`  ℹ ${note}`);
  for (const problem of result.problems) console.log(`  ✖ ${problem}`);
  if (result.problems.length === 0) {
    printPoints(result.points);
    console.log('  ✓ Ошибок нет, каждая точка совпадает с пересчётом, «сейчас» = «Счета»');
  }
  return result.problems.length;
}

async function create(input: CapitalInput, index: number | undefined): Promise<void> {
  const replies = await batch([addCapitalSheet(index)]);
  const sheetId = replies[0]?.addSheet?.properties?.sheetId;
  if (sheetId == null) fail('Sheets не вернул id нового листа');
  console.log(`\n✓ Лист «${CAPITAL_SHEET}» создан`);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: capitalValues(input) },
  });
  console.log('✓ Подписи и формулы записаны');
  const formatting = capitalFormatRequests(sheetId);
  await batch(formatting);
  console.log(`✓ Оформление и график (${formatting.length} запросов)`);
}

/** Refuses an --apply that would touch the live sheet or an existing one without saying so. */
function guardApply(existing: SheetInfo | undefined): void {
  if (isLive && !has('--live')) {
    fail('Это ЖИВАЯ таблица: для --apply добавь --live (или задай SPREADSHEET_ID копии)');
  }
  if (existing && !has('--replace')) {
    fail(`Уже есть «${CAPITAL_SHEET}». Пересоздать: --apply --replace (там только формулы)`);
  }
}

async function apply(input: CapitalInput, existing: SheetInfo | undefined): Promise<void> {
  if (existing) {
    await batch([{ deleteSheet: { sheetId: existing.sheetId } }]);
    console.log(`\n✓ Удалён старый «${CAPITAL_SHEET}»`);
  }
  const dashboard = (await listSheets()).sheets.find((s) => s.title === DASHBOARD_SHEET);
  try {
    await create(input, dashboard === undefined ? undefined : dashboard.index + 1);
  } catch (error) {
    console.error('\n✖ Остановились на полпути. Лист мог остаться недоделанным: --apply --replace');
    throw error;
  }
  const failures = await verify();
  console.log(failures === 0 ? '\nГотово.' : `\nПроблем: ${failures} — смотри выше.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const info = await listSheets();
  console.log(`Таблица: «${info.title}» (${isLive ? 'ЖИВАЯ' : 'копия'})`);
  const existing = info.sheets.find((s) => s.title === CAPITAL_SHEET);

  if (has('--check')) {
    if (!existing) fail(`Нет листа «${CAPITAL_SHEET}» — нечего проверять`);
    process.exitCode = (await verify()) === 0 ? 0 : 1;
    return;
  }
  if (has('--apply')) guardApply(existing);

  const sources = await readSources();
  const input = preflight(sources);
  describePlan(input, sources);
  if (has('--apply')) return apply(input, existing);
  if (existing) console.log(`\nЛист «${CAPITAL_SHEET}» уже есть: нужен --replace.`);
  console.log('\nDry run. Запусти с --apply, чтобы применить.');
}

await main();

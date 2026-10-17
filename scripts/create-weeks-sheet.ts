/**
 * Creates the formula-only sheet «Недели» (categories × 1–8 / 9–16 / 17–24 / 25–end buckets of six
 * months, docs/SHEET_V2.md §8) and its hidden helper «_Недели». The bot never reads or writes them.
 * Columns of «Операции» are found by header name, so it works before and after `yarn migrate-sheet`.
 *
 * Usage: yarn weeks-sheet [--apply] [--replace] [--live] [--check]
 *   without --apply — dry run: checks the sheet and prints the plan (read-only);
 *   --apply — creates both sheets, fills them, styles them and verifies the result;
 *   --replace — with --apply: deletes the existing «Недели» and «_Недели» first (formulas only);
 *   --live — required with --apply when the spreadsheet is the default (live) one;
 *   --check — only verifies the existing sheets (read-only), e.g. after «Categories» changed.
 * SPREADSHEET_ID=<id of a copy> picks the spreadsheet; the default is the live one.
 */
import type { sheets_v4 } from 'googleapis';
import { envSchema } from '../src/config/env.js';
import type { Category } from '../src/domain/reference.js';
import { initSheets } from '../src/sheets/client.js';
import { OPERATIONS_SHEET } from '../src/sheets/operations.js';
import { createReferenceStore } from '../src/sheets/reference.js';
import {
  addSheetRequests,
  buildWeeksLayout,
  checkWeeks,
  columnLetter,
  expenseCategories,
  findColumns,
  HELPER_SHEET,
  helperRowCount,
  RATES_SHEET,
  sampleFormulas,
  WEEKS_COLUMNS,
  WEEKS_SHEET,
  weeksRequests,
  type OperationColumns,
  type WeeksLayout,
} from '../src/sheets/weeks-layout.js';

const FLAGS = ['--apply', '--replace', '--live', '--check'];
const MONTHLY_SHEET = 'Категории по месяцам';
const VERIFY_ATTEMPTS = 6;
const VERIFY_DELAY_MS = 5000;

const args = process.argv.slice(2);
const unknownFlags = args.filter((arg) => !FLAGS.includes(arg));
if (unknownFlags.length > 0) fail(`Неизвестные флаги: ${unknownFlags.join(' ')}`);
const has = (flag: string) => args.includes(flag);

const env = envSchema
  .pick({ GOOGLE_SERVICE_ACCOUNT_EMAIL: true, GOOGLE_PRIVATE_KEY: true, SPREADSHEET_ID: true })
  .parse(process.env);

const sheets = initSheets(env);
const spreadsheetId = env.SPREADSHEET_ID;
const isLive = spreadsheetId === envSchema.shape.SPREADSHEET_ID.parse(undefined);

type Grid = unknown[][];

interface SheetInfo {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
}

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function read(range: string): Promise<Grid> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (response.data.values ?? []) as Grid;
}

async function batch(requests: sheets_v4.Schema$Request[]): Promise<sheets_v4.Schema$Response[]> {
  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
  return response.data.replies ?? [];
}

async function listSheets(): Promise<{ title: string; sheets: SheetInfo[] }> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties(sheetId,title,index,gridProperties.rowCount)',
  });
  return {
    title: meta.data.properties?.title ?? spreadsheetId,
    sheets: (meta.data.sheets ?? []).flatMap((s) =>
      s.properties?.sheetId == null
        ? []
        : [
            {
              sheetId: s.properties.sheetId,
              title: s.properties.title ?? '',
              index: s.properties.index ?? 0,
              rowCount: s.properties.gridProperties?.rowCount ?? 0,
            },
          ],
    ),
  };
}

async function loadCategories(): Promise<Category[]> {
  return (await createReferenceStore(sheets, spreadsheetId).reload()).categories;
}

interface Preflight {
  columns: OperationColumns;
  rubRow: number;
  categories: Category[];
}

/** Everything the layout depends on; exits with a clear message if the sheet isn't what we expect. */
async function preflight(): Promise<Preflight> {
  const found = findColumns((await read(`${OPERATIONS_SHEET}!A1:Z1`))[0] ?? []);
  if (!found.ok) {
    fail(
      `В шапке «${OPERATIONS_SHEET}» нет колонок: ${found.missing.map((m) => `«${m}»`).join(', ')}`,
    );
  }

  const ratesHeader = ((await read(`${RATES_SHEET}!H3:I3`))[0] ?? []).map((v) =>
    text(v).toLowerCase(),
  );
  if (ratesHeader[0] !== 'дата' || ratesHeader[1] !== 'usdrub') {
    fail(`«${RATES_SHEET}»!H3:I3 = ${JSON.stringify(ratesHeader)}, ожидалось «Дата» / «USDRUB»`);
  }

  const rates = await read(`${RATES_SHEET}!A1:E`);
  const rubIndex = rates.findIndex((row, i) => i >= 3 && text(row[0]) === 'RUB');
  if (rubIndex === -1) fail(`В «${RATES_SHEET}»!A4:A нет строки RUB`);
  if (typeof rates[rubIndex]?.[4] !== 'number') {
    fail(`«${RATES_SHEET}»!E${rubIndex + 1} (текущий курс RUB) — не число`);
  }

  let categories: Category[];
  try {
    categories = await loadCategories();
  } catch (error) {
    return fail(
      `«Categories» не читается: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (expenseCategories(categories).length === 0) fail('В «Categories» нет категорий расходов');

  return { columns: found.columns, rubRow: rubIndex + 1, categories };
}

function countRequests(requests: sheets_v4.Schema$Request[]): string {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const key = Object.keys(request)[0] ?? '?';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key} ${count}`).join(', ');
}

function describePlan(layout: WeeksLayout, pre: Preflight, operationsRows: number): void {
  const { columns } = layout;
  const migrated = columns.currency === 'M';
  console.log(
    `\n«${OPERATIONS_SHEET}»: ${migrated ? 'после миграции (L = Добавлено)' : 'до миграции (L = Валюта)'}`,
  );
  console.log(
    '  Колонки: ' +
      Object.entries(columns)
        .map(([key, letter]) => `${key}=${letter}`)
        .join(' '),
  );
  console.log(`  Курс RUB: «${RATES_SHEET}»!E${pre.rubRow}`);

  console.log(
    `\n«${WEEKS_SHEET}»: A…${columnLetter(WEEKS_COLUMNS - 1)}, строк ${layout.lastRow}, группы свёрнуты`,
  );
  for (const row of layout.rows.filter((r) => r.kind !== 'sub' && r.kind !== 'rest')) {
    const group = layout.groups.find((g) => g.header === row.row);
    const detail = group
      ? ` (${row.category}) — подкатегории и остаток: строки ${group.first}–${group.last}`
      : row.kind === 'cat'
        ? ` (${row.category}) — без подкатегорий`
        : '';
    console.log(`  ${String(row.row).padStart(4)}  ${row.label}${detail}`);
  }

  console.log('\nОбразцы формул:');
  for (const [what, cell, formula] of sampleFormulas(layout)) {
    console.log(`  [${what}] ${cell}\n    ${formula}`);
  }

  const formatting = weeksRequests(layout, { weeks: 0, helper: 1 });
  console.log(
    [
      '',
      'Запросы:',
      `  addSheet: 2 («${HELPER_SHEET}» скрыт, ${helperRowCount(operationsRows)} строк × 10 колонок; «${WEEKS_SHEET}» после «${MONTHLY_SHEET}»)`,
      `  values.batchUpdate: 2 диапазона (${layout.helper.range}, ${layout.weeks.range})`,
      `  форматирование: ${formatting.length} (${countRequests(formatting)})`,
    ].join('\n'),
  );
}

/** Reads both sheets and checks them, retrying while the formulas are still being calculated. */
async function verify(categories: Category[], hasMonthly: boolean): Promise<number> {
  console.log('\nПроверка:');
  let result = { problems: [] as string[], notes: [] as string[] };

  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    const [weeks, helper, monthly] = await Promise.all([
      read(`'${WEEKS_SHEET}'!A1:${columnLetter(WEEKS_COLUMNS - 1)}`),
      read(`'${HELPER_SHEET}'!A1:J`),
      hasMonthly ? read(`'${MONTHLY_SHEET}'!A1:AD`) : Promise.resolve(null),
    ]);
    result = checkWeeks({ weeks, helper, monthly, categories });
    if (result.problems.length === 0) break;
    if (attempt < VERIFY_ATTEMPTS) {
      console.log(
        `  … ещё считается (попытка ${attempt}/${VERIFY_ATTEMPTS}): ${result.problems[0]}`,
      );
      await sleep(VERIFY_DELAY_MS);
    }
  }

  for (const note of result.notes) console.log(`  ℹ ${note}`);
  for (const problem of result.problems) console.log(`  ✖ ${problem}`);
  if (result.problems.length === 0) console.log('  ✓ Ошибок нет, контроль 0, суммы сходятся');
  return result.problems.length;
}

async function createSheets(layout: WeeksLayout, operationsRows: number): Promise<void> {
  const { sheets: before } = await listSheets();
  const weeksIndex = before.find((s) => s.title === MONTHLY_SHEET)?.index;
  const replies = await batch(
    addSheetRequests(layout, {
      helperRows: helperRowCount(operationsRows),
      weeksIndex: weeksIndex === undefined ? undefined : weeksIndex + 1,
    }),
  );
  const helperId = replies[0]?.addSheet?.properties?.sheetId;
  const weeksId = replies[1]?.addSheet?.properties?.sheetId;
  if (helperId == null || weeksId == null) fail('Sheets не вернул id новых листов');
  console.log(`\n✓ Листы «${WEEKS_SHEET}» и «${HELPER_SHEET}» созданы`);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: [layout.helper, layout.weeks] },
  });
  console.log('✓ Подписи, формулы и контролы записаны');

  const formatting = weeksRequests(layout, { weeks: weeksId, helper: helperId });
  await batch(formatting);
  console.log(`✓ Оформление применено (${formatting.length} запросов)`);
}

async function main(): Promise<void> {
  const apply = has('--apply');
  const info = await listSheets();
  console.log(`Таблица: «${info.title}» (${isLive ? 'ЖИВАЯ' : 'копия'})`);

  const existing = info.sheets.filter((s) => s.title === WEEKS_SHEET || s.title === HELPER_SHEET);
  const hasMonthly = info.sheets.some((s) => s.title === MONTHLY_SHEET);

  if (has('--check')) {
    if (existing.length < 2)
      fail(`Нет листов «${WEEKS_SHEET}» и «${HELPER_SHEET}» — нечего проверять`);
    process.exitCode = (await verify(await loadCategories(), hasMonthly)) === 0 ? 0 : 1;
    return;
  }

  if (apply && isLive && !has('--live')) {
    fail('Это ЖИВАЯ таблица: для --apply добавь --live (или задай SPREADSHEET_ID копии)');
  }
  if (apply && existing.length > 0 && !has('--replace')) {
    fail(
      `Уже есть: ${existing.map((s) => `«${s.title}»`).join(', ')}. ` +
        'Пересоздать: --apply --replace (там только формулы)',
    );
  }

  const pre = await preflight();
  const operationsRows = info.sheets.find((s) => s.title === OPERATIONS_SHEET)?.rowCount ?? 0;
  const layout = buildWeeksLayout(pre);
  describePlan(layout, pre, operationsRows);
  if (!hasMonthly) {
    console.log(
      `\n⚠ Нет листа «${MONTHLY_SHEET}»: «${WEEKS_SHEET}» встанет в конец, суммы сверить не с чем`,
    );
  }

  if (!apply) {
    if (existing.length > 0) {
      console.log(
        `\nЛисты уже есть (${existing.map((s) => s.title).join(', ')}): нужен --replace.`,
      );
    }
    console.log('\nDry run. Запусти с --apply, чтобы применить.');
    return;
  }

  if (existing.length > 0) {
    await batch(existing.map((s) => ({ deleteSheet: { sheetId: s.sheetId } })));
    console.log(`\n✓ Удалены: ${existing.map((s) => `«${s.title}»`).join(', ')}`);
  }

  try {
    await createSheets(layout, operationsRows);
  } catch (error) {
    console.error(
      `\n✖ Остановились на полпути. Листы могли остаться недоделанными: --apply --replace`,
    );
    throw error;
  }

  const failures = await verify(pre.categories, hasMonthly);
  console.log(failures === 0 ? '\nГотово.' : `\nПроблем: ${failures} — смотри выше.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();

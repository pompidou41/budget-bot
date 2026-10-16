/**
 * One-off migration of «Операции» to the two-date layout (docs/SHEET_V2.md §2):
 *  - inserts column L «Добавлено»; the formulas L:T move to M:U and other sheets' references follow;
 *  - moves the ARRAYFORMULAs from row 2 into the header row, so sorting the data can't break them;
 *  - backfills «Добавлено» with «Дата» for existing rows;
 *  - protects M1:U (warning only), now including the header formulas;
 *  - hides the ARCHIVE rows with the filter instead of hiding rows by hand: hidden rows stay
 *    hidden by position, so after a sort they would hide other operations.
 * Checks afterwards that every row keeps its computed values and «Счета»/«Дашборд»/«Категории по
 * месяцам» show the same numbers.
 *
 * Usage: yarn migrate-sheet [--apply] [--sort-test]
 *   without --apply — dry run: checks and prints what would change;
 *   --sort-test — sorts the data by «Добавлено» and by «Дата» and re-checks (copies only).
 * SPREADSHEET_ID=<id of a copy> picks the spreadsheet; the default is the live one.
 */
import type { sheets_v4 } from 'googleapis';
import { envSchema } from '../src/config/env.js';
import { initSheets } from '../src/sheets/client.js';
import { OPERATIONS_SHEET } from '../src/sheets/operations.js';
import { checkOperationsHeader, compareHeaders } from '../src/sheets/schema-check.js';

const env = envSchema
  .pick({ GOOGLE_SERVICE_ACCOUNT_EMAIL: true, GOOGLE_PRIVATE_KEY: true, SPREADSHEET_ID: true })
  .parse(process.env);
const apply = process.argv.includes('--apply');
const sortTest = process.argv.includes('--sort-test');

const sheets = initSheets(env);
const spreadsheetId = env.SPREADSHEET_ID;
const isLive = spreadsheetId === envSchema.shape.SPREADSHEET_ID.parse(undefined);

const ADDED_COLUMN = 11; // L, 0-based
const FORMULA_COLUMNS = 9; // M:U after the insert, L:T before
const PROTECTION = 'Расчётные колонки';
const REPORT_SHEETS = ["'Счета'!A1:L", "'Дашборд'!A1:P", "'Категории по месяцам'!A1:AD"];
const ACCOUNT_COLUMN = 2; // C
const ARCHIVE_ACCOUNT = 'ARCHIVE';

type Grid = unknown[][];

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function read(range: string, render: 'FORMULA' | 'UNFORMATTED_VALUE'): Promise<Grid> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: render,
  });
  return (response.data.values ?? []) as Grid;
}

async function batch(requests: sheets_v4.Schema$Request[]): Promise<void> {
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

async function operationsSheet() {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields:
      'properties.title,sheets(properties(sheetId,title,gridProperties),protectedRanges,basicFilter)',
  });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === OPERATIONS_SHEET);
  if (sheet?.properties?.sheetId == null) fail(`Нет листа «${OPERATIONS_SHEET}»`);
  return {
    title: meta.data.properties?.title ?? spreadsheetId,
    sheetId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties?.rowCount ?? 0,
    protectedRanges: sheet.protectedRanges ?? [],
    basicFilter: sheet.basicFilter,
  };
}

function cell(value: unknown): unknown {
  return value === undefined || value === null ? '' : value;
}

function pad(row: unknown[], width: number): unknown[] {
  return Array.from({ length: width }, (_, i) => cell(row[i]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return cell(a) === cell(b);
}

function isEmptyRow(row: unknown[]): boolean {
  return row.every((value) => cell(value) === '' || value === false);
}

/** Cells that differ between two grids, as `R<row>C<col>: before → after`. */
function diffGrids(before: Grid, after: Grid, rowOffset = 1): string[] {
  const diffs: string[] = [];
  const rows = Math.max(before.length, after.length);
  for (let r = 0; r < rows; r++) {
    const a = before[r] ?? [];
    const b = after[r] ?? [];
    for (let c = 0; c < Math.max(a.length, b.length); c++) {
      if (!sameValue(a[c], b[c])) {
        diffs.push(`R${r + rowOffset}C${c + 1}: ${String(cell(a[c]))} → ${String(cell(b[c]))}`);
      }
    }
  }
  return diffs;
}

async function reportSnapshot(): Promise<Grid[]> {
  return Promise.all(REPORT_SHEETS.map((range) => read(range, 'UNFORMATTED_VALUE')));
}

function compareReports(before: Grid[], after: Grid[]): number {
  let total = 0;
  REPORT_SHEETS.forEach((range, i) => {
    const diffs = diffGrids(before[i] ?? [], after[i] ?? []);
    total += diffs.length;
    console.log(
      diffs.length === 0 ? `  ✓ ${range}: без изменений` : `  ✖ ${range}: ${diffs.length} отличий`,
    );
    for (const diff of diffs.slice(0, 10)) console.log(`      ${diff}`);
  });
  return total;
}

/** Data rows A:U as sorted JSON strings — the same multiset means every row kept its values. */
function rowSet(rows: Grid): string[] {
  return rows
    .map((row) => pad(row, 21))
    .filter((row) => !isEmptyRow(row.slice(0, ADDED_COLUMN + 1)))
    .map((row) => JSON.stringify(row))
    .sort();
}

/** Problems in the migrated «Операции»: header, errors in M:U, rows without «Добавлено». */
async function checkOperations(oldFormulaHeaders: unknown[] | null): Promise<string[]> {
  const problems = await checkOperationsHeader(sheets, spreadsheetId);
  const rows = await read(`${OPERATIONS_SHEET}!A1:U`, 'UNFORMATTED_VALUE');
  const header = pad(rows[0] ?? [], 21);

  if (oldFormulaHeaders) {
    const expected = pad(oldFormulaHeaders, FORMULA_COLUMNS);
    if (JSON.stringify(header.slice(12)) !== JSON.stringify(expected)) {
      problems.push(
        `Шапка M1:U1 ${JSON.stringify(header.slice(12))}, ожидалась ${JSON.stringify(expected)}`,
      );
    }
  }

  let errors = 0;
  let undated = 0;
  for (const raw of rows.slice(1)) {
    const row = pad(raw, 21);
    if (row.slice(12).some((v) => (typeof v === 'string' && v.startsWith('#')) || v === '?'))
      errors++;
    if (typeof row[0] === 'number' && typeof row[ADDED_COLUMN] !== 'number') undated++;
  }
  if (errors > 0) problems.push(`Строк с ошибками в M:U: ${errors}`);
  if (undated > 0) problems.push(`Строк с датой, но без «Добавлено»: ${undated}`);
  return problems;
}

/** 1-based rows of «Операции» hidden by hand and hidden by the filter. */
async function hiddenRows(): Promise<{ byUser: number[]; byFilter: number[] }> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`${OPERATIONS_SHEET}!A:A`],
    fields: 'sheets.data.rowMetadata(hiddenByUser,hiddenByFilter)',
  });
  const rows = response.data.sheets?.[0]?.data?.[0]?.rowMetadata ?? [];
  const pick = (key: 'hiddenByUser' | 'hiddenByFilter') =>
    rows.flatMap((meta, i) => (meta[key] ? [i + 1] : []));
  return { byUser: pick('hiddenByUser'), byFilter: pick('hiddenByFilter') };
}

/** 1-based rows whose account (C) is the archive. */
async function archiveRows(): Promise<number[]> {
  const rows = await read(`${OPERATIONS_SHEET}!C1:C`, 'UNFORMATTED_VALUE');
  return rows.flatMap((row, i) => (row[0] === ARCHIVE_ACCOUNT ? [i + 1] : []));
}

/** The header filter over A1:U with only the given column conditions (no deprecated `criteria`). */
function basicFilter(
  sheetId: number,
  rowCount: number,
  current: sheets_v4.Schema$BasicFilter | undefined,
  filterSpecs: sheets_v4.Schema$FilterSpec[],
): sheets_v4.Schema$Request {
  const range = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: rowCount,
    startColumnIndex: 0,
    endColumnIndex: 21,
  };
  return { setBasicFilter: { filter: { range, sortSpecs: current?.sortSpecs, filterSpecs } } };
}

/** Hand-hidden rows that are exactly the ARCHIVE rows become hidden by the filter instead. */
async function hideArchiveByFilter(sheetId: number, rowCount: number): Promise<void> {
  const [hidden, archive] = await Promise.all([hiddenRows(), archiveRows()]);
  if (hidden.byUser.length === 0) {
    console.log('✓ Строк, скрытых вручную, нет');
    return;
  }
  if (JSON.stringify(hidden.byUser) !== JSON.stringify(archive)) {
    console.log(
      `⚠ Вручную скрыто ${hidden.byUser.length} строк, и это не ровно строки ${ARCHIVE_ACCOUNT} — не трогаю`,
    );
    return;
  }

  const current = (await operationsSheet()).basicFilter;
  const otherSpecs = (current?.filterSpecs ?? []).filter((s) => s.columnIndex !== ACCOUNT_COLUMN);
  await batch([
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: rowCount },
        properties: { hiddenByUser: false },
        fields: 'hiddenByUser',
      },
    },
    basicFilter(sheetId, rowCount, current, [
      ...otherSpecs,
      { columnIndex: ACCOUNT_COLUMN, filterCriteria: { hiddenValues: [ARCHIVE_ACCOUNT] } },
    ]),
  ]);
  console.log(`✓ ${archive.length} строк ${ARCHIVE_ACCOUNT} скрыты фильтром «Счёт», а не вручную`);
}

/** Hidden rows must be exactly the ARCHIVE ones, and hidden by the filter — wherever they are now. */
async function checkHidden(): Promise<string[]> {
  const [hidden, archive] = await Promise.all([hiddenRows(), archiveRows()]);
  const problems: string[] = [];
  if (hidden.byUser.length > 0) problems.push(`Строк, скрытых вручную: ${hidden.byUser.length}`);
  if (JSON.stringify(hidden.byFilter) !== JSON.stringify(archive)) {
    problems.push(
      `Фильтр скрывает ${hidden.byFilter.length} строк, а строк ${ARCHIVE_ACCOUNT} — ${archive.length}`,
    );
  }
  return problems;
}

/**
 * Warning-only protection over M1:U. Sorting from the filter menu asks «Heads up!» because of it
 * (any protection inside the filter range does that) — kept on purpose, so typing into M:U asks too.
 */
function protectFormulas(
  protectedRangeId: number,
  sheetId: number,
  rowCount: number,
): sheets_v4.Schema$Request {
  const range = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: rowCount,
    startColumnIndex: 12,
    endColumnIndex: 21,
  };
  return { updateProtectedRange: { protectedRange: { protectedRangeId, range }, fields: 'range' } };
}

async function runSortTest(sheetId: number, rowCount: number): Promise<number> {
  if (isLive) fail('--sort-test только для копии: задай SPREADSHEET_ID копии');

  const reportsBefore = await reportSnapshot();
  const rowsBefore = rowSet(await read(`${OPERATIONS_SHEET}!A2:U`, 'UNFORMATTED_VALUE'));
  let failures = 0;

  for (const [label, dimensionIndex, sortOrder] of [
    ['«Добавлено» по убыванию', ADDED_COLUMN, 'DESCENDING'],
    ['«Дата» по возрастанию', 0, 'ASCENDING'],
  ] as const) {
    await batch([
      {
        sortRange: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: rowCount,
            startColumnIndex: 0,
            endColumnIndex: 21,
          },
          sortSpecs: [{ dimensionIndex, sortOrder }],
        },
      },
    ]);
    console.log(`\nСортировка: ${label}`);

    const rowsAfter = rowSet(await read(`${OPERATIONS_SHEET}!A2:U`, 'UNFORMATTED_VALUE'));
    const same = JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore);
    console.log(same ? '  ✓ строки «Операции» те же' : '  ✖ строки «Операции» изменились');
    if (!same) failures++;

    failures += compareReports(reportsBefore, await reportSnapshot());
    const problems = [...(await checkOperations(null)), ...(await checkHidden())];
    for (const problem of problems) console.log(`  ✖ ${problem}`);
    if (problems.length === 0) console.log(`  ✓ скрыты ровно строки ${ARCHIVE_ACCOUNT}`);
    failures += problems.length;
  }
  return failures;
}

const sheet = await operationsSheet();
console.log(
  `Таблица: «${sheet.title}» (${isLive ? 'ЖИВАЯ' : 'копия'}), строк в сетке: ${sheet.rowCount}`,
);

const head = await read(`${OPERATIONS_SHEET}!A1:L2`, 'FORMULA');
const header = head[0] ?? [];

if (String(header[ADDED_COLUMN] ?? '').trim() === 'Добавлено') {
  console.log('Уже мигрировано: L1 = «Добавлено».');
  if (apply) {
    const protection = sheet.protectedRanges.find((p) => p.description === PROTECTION);
    if (protection?.protectedRangeId != null) {
      await batch([protectFormulas(protection.protectedRangeId, sheet.sheetId, sheet.rowCount)]);
      console.log(`✓ Защита «${PROTECTION}» → M1:U`);
    }
    await hideArchiveByFilter(sheet.sheetId, sheet.rowCount);
    if (sortTest) process.exitCode = (await runSortTest(sheet.sheetId, sheet.rowCount)) ? 1 : 0;
  }
  process.exit();
}

const headerProblems = compareHeaders([...header.slice(0, ADDED_COLUMN), 'Добавлено']);
if (headerProblems.length > 0) fail(`Шапка A1:K1 не та:\n  ${headerProblems.join('\n  ')}`);
if (header[ADDED_COLUMN] !== 'Валюта')
  fail(`L1 = «${String(header[ADDED_COLUMN])}», ожидалось «Валюта»`);
if (!String(head[1]?.[ADDED_COLUMN] ?? '').startsWith('=ARRAYFORMULA')) {
  fail('В L2 нет ARRAYFORMULA — раскладка не та, что ожидалась');
}
const protection = sheet.protectedRanges.find((p) => p.description === PROTECTION);
if (protection?.protectedRangeId == null) fail(`Нет защищённого диапазона «${PROTECTION}»`);

const oldFormulaHeaders = (await read(`${OPERATIONS_SHEET}!L1:T1`, 'UNFORMATTED_VALUE'))[0] ?? [];
const oldRows = await read(`${OPERATIONS_SHEET}!A2:T`, 'UNFORMATTED_VALUE');
const reportsBefore = await reportSnapshot();
const datedRows = oldRows.filter((row) => typeof row[0] === 'number').length;

console.log(`Формулы L:T: ${oldFormulaHeaders.join(' | ')}`);
console.log(`Строк с датой: ${datedRows}`);
console.log(
  [
    '',
    'План:',
    '  1. Вставить колонку L «Добавлено» (формулы L:T → M:U, ссылки других листов сдвинутся сами)',
    '  2. Перенести ARRAYFORMULA из M2:U2 в шапку M1:U1 как ={"<заголовок>";ARRAYFORMULA(…)}',
    '  3. Формат L: dd.mm.yyyy hh:mm; шапка L1 — как K1',
    `  4. Заполнить «Добавлено» = «Дата» для ${datedRows} строк`,
    `  5. Защита «${PROTECTION}» → M1:U, вместе с шапкой (только предупреждение)`,
    '  6. Фильтр шапки → A1:U',
    `  7. Строки ${ARCHIVE_ACCOUNT}, скрытые вручную, — скрыть фильтром по «Счёт» (переживает сортировку)`,
  ].join('\n'),
);

if (!apply) {
  console.log('\nDry run. Запусти с --apply, чтобы применить.');
  process.exit();
}

const { sheetId, rowCount } = sheet;
const columns = (start: number, end: number, startRow = 0, endRow = rowCount) => ({
  sheetId,
  startRowIndex: startRow,
  endRowIndex: endRow,
  startColumnIndex: start,
  endColumnIndex: end,
});

// 1. Insert L. References inside and outside the sheet, protection and filter shift with it
await batch([
  {
    insertDimension: {
      range: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex: ADDED_COLUMN,
        endIndex: ADDED_COLUMN + 1,
      },
      inheritFromBefore: false,
    },
  },
]);
console.log('\n✓ Колонка L вставлена');

// 2. Formulas move from the first data row into the header row, which sorting never touches
const shifted = await read(`${OPERATIONS_SHEET}!M1:U2`, 'FORMULA');
const titles = pad(shifted[0] ?? [], FORMULA_COLUMNS);
const formulas = pad(shifted[1] ?? [], FORMULA_COLUMNS).map(String);
if (!formulas.every((f) => f.startsWith('=ARRAYFORMULA'))) {
  fail(`После вставки в M2:U2 не только ARRAYFORMULA: ${JSON.stringify(formulas)}`);
}
const headerFormulas = formulas.map(
  (formula, i) => `={"${String(titles[i]).replace(/"/g, '""')}";${formula.slice(1)}}`,
);

const filter = (await operationsSheet()).basicFilter;

await batch([
  {
    updateCells: {
      range: columns(12, 21, 1, 2),
      fields: 'userEnteredValue',
      rows: [{ values: [] }],
    },
  },
  {
    updateCells: {
      range: columns(12, 21, 0, 1),
      fields: 'userEnteredValue',
      rows: [
        { values: headerFormulas.map((formulaValue) => ({ userEnteredValue: { formulaValue } })) },
      ],
    },
  },
  // 3. Header and format of «Добавлено»
  {
    copyPaste: {
      source: columns(10, 11, 0, 1),
      destination: columns(11, 12, 0, 1),
      pasteType: 'PASTE_FORMAT',
    },
  },
  {
    updateCells: {
      range: columns(11, 12, 0, 1),
      fields: 'userEnteredValue',
      rows: [{ values: [{ userEnteredValue: { stringValue: 'Добавлено' } }] }],
    },
  },
  {
    repeatCell: {
      range: columns(11, 12, 1),
      cell: {
        userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd.mm.yyyy hh:mm' } },
      },
      fields: 'userEnteredFormat.numberFormat',
    },
  },
  {
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex: ADDED_COLUMN,
        endIndex: ADDED_COLUMN + 1,
      },
      properties: { pixelSize: 125 },
      fields: 'pixelSize',
    },
  },
  // 5. Protection now covers the header formulas too
  protectFormulas(protection.protectedRangeId, sheetId, rowCount),
  // 6. Filter spans the new column
  ...(filter?.range?.endColumnIndex === 21
    ? []
    : [basicFilter(sheetId, rowCount, filter, filter?.filterSpecs ?? [])]),
]);
console.log('✓ Формулы перенесены в шапку, L оформлена, защита и фильтр обновлены');

// 4. Existing rows: «Добавлено» = «Дата»
const lastDated = oldRows.reduce((last, row, i) => (typeof row[0] === 'number' ? i : last), -1);
if (lastDated >= 0) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${OPERATIONS_SHEET}!L2:L${lastDated + 2}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: oldRows
        .slice(0, lastDated + 1)
        .map((row) => [typeof row[0] === 'number' ? row[0] : '']),
    },
  });
}
console.log(`✓ «Добавлено» заполнено для ${datedRows} строк`);

// 7. Archive rows: hidden by the filter, so a sort can't hide other operations
await hideArchiveByFilter(sheetId, rowCount);

// Checks: every row kept its values (A:K, then L = A, then the old L:T), reports unchanged
console.log('\nПроверка:');
let failures = 0;
const expectedRows = oldRows.map((raw) => {
  const row = pad(raw, 20);
  return [
    ...row.slice(0, ADDED_COLUMN),
    typeof row[0] === 'number' ? row[0] : '',
    ...row.slice(ADDED_COLUMN),
  ];
});
const newRows = (await read(`${OPERATIONS_SHEET}!A2:U`, 'UNFORMATTED_VALUE')).map((row) =>
  pad(row, 21),
);
const rowDiffs = diffGrids(expectedRows, newRows, 2);
console.log(
  rowDiffs.length === 0
    ? '  ✓ «Операции»: все строки на месте'
    : `  ✖ «Операции»: ${rowDiffs.length} отличий`,
);
for (const diff of rowDiffs.slice(0, 10)) console.log(`      ${diff}`);
failures += rowDiffs.length;

failures += compareReports(reportsBefore, await reportSnapshot());

const problems = [...(await checkOperations(oldFormulaHeaders)), ...(await checkHidden())];
for (const problem of problems) console.log(`  ✖ ${problem}`);
if (problems.length === 0) console.log('  ✓ Шапка A1:L1, формулы M:U и скрытие архива в порядке');
failures += problems.length;

if (sortTest) failures += await runSortTest(sheetId, rowCount);

console.log(
  failures === 0 ? '\nГотово, расхождений нет.' : `\nРасхождений: ${failures} — смотри выше.`,
);
process.exitCode = failures === 0 ? 0 : 1;

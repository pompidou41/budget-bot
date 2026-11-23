/**
 * Read-only sanity check of the spreadsheet: reference data and «Операции» header.
 * Usage: yarn check-sheet   (needs GOOGLE_* and optionally SPREADSHEET_ID in .env)
 */
import { envSchema } from '../src/config/env.js';
import { activeAccounts } from '../src/domain/reference.js';
import { initSheets } from '../src/sheets/client.js';
import { createReferenceStore } from '../src/sheets/reference.js';
import { checkOperationsHeader } from '../src/sheets/schema-check.js';
import { capacityWarning, SUBS_SHEET } from '../src/sheets/subcategories-plan.js';

const env = envSchema
  .pick({ GOOGLE_SERVICE_ACCOUNT_EMAIL: true, GOOGLE_PRIVATE_KEY: true, SPREADSHEET_ID: true })
  .parse(process.env);

const sheets = initSheets(env);
const ref = await createReferenceStore(sheets, env.SPREADSHEET_ID).reload();

console.log(`\nAccounts: ${ref.accounts.length} (active ${activeAccounts(ref).length})`);
for (const a of ref.accounts) {
  console.log(`  ${a.id.padEnd(12)} ${a.currency.padEnd(5)} ${a.group.padEnd(14)} ${a.name}`);
}

console.log(`\nCategories: ${ref.categories.length}`);
for (const c of ref.categories) {
  console.log(`  ${c.name}: ${c.subcategories.join(', ') || '—'}`);
}

const problems = await checkOperationsHeader(sheets, env.SPREADSHEET_ID);
console.log(
  problems.length === 0
    ? '\n«Операции» header: OK'
    : `\n«Операции» header mismatch:\n  ${problems.join('\n  ')}`,
);

// «_Подкатегории» covers a fixed number of «Операции» rows (docs/SHEET_V2.md §4)
const [meta, used] = await Promise.all([
  sheets.spreadsheets.get({
    spreadsheetId: env.SPREADSHEET_ID,
    fields: 'sheets.properties(title,gridProperties.rowCount)',
  }),
  sheets.spreadsheets.values.get({ spreadsheetId: env.SPREADSHEET_ID, range: 'Операции!A:A' }),
]);
const subs = meta.data.sheets?.find((s) => s.properties?.title === SUBS_SHEET);
const capacity = subs?.properties?.gridProperties?.rowCount;
if (capacity === undefined || capacity === null) {
  console.log(`\nЛист «${SUBS_SHEET}» ещё не создан (yarn settlements-sheet)`);
} else {
  const warning = capacityWarning(used.data.values?.length ?? 0, capacity);
  console.log(warning ? `\n⚠ ${warning}` : `\n«${SUBS_SHEET}»: места хватает`);
}
process.exitCode = problems.length === 0 ? 0 : 1;

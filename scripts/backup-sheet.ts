/**
 * Read-only snapshot of the whole spreadsheet into data/backups/<timestamp>/:
 * sheet metadata (protections, filters, conditional formats) plus formulas and raw values of every sheet.
 * Usage: yarn backup-sheet   (needs GOOGLE_* and optionally SPREADSHEET_ID in .env)
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { envSchema } from '../src/config/env.js';
import { initSheets } from '../src/sheets/client.js';

const env = envSchema
  .pick({ GOOGLE_SERVICE_ACCOUNT_EMAIL: true, GOOGLE_PRIVATE_KEY: true, SPREADSHEET_ID: true })
  .parse(process.env);

const sheets = initSheets(env);
const spreadsheetId = env.SPREADSHEET_ID;

const meta = await sheets.spreadsheets.get({
  spreadsheetId,
  fields:
    'spreadsheetId,properties,namedRanges,sheets(properties,protectedRanges,basicFilter,filterViews,conditionalFormats,merges)',
});
const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '');

const dir = join('data', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta.data, null, 2));

for (const render of ['FORMULA', 'UNFORMATTED_VALUE'] as const) {
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: titles.map((title) => `'${title.replace(/'/g, "''")}'`),
    valueRenderOption: render,
  });
  const byTitle = Object.fromEntries(
    (response.data.valueRanges ?? []).map((range, i) => [titles[i], range.values ?? []]),
  );
  writeFileSync(join(dir, `${render.toLowerCase()}.json`), JSON.stringify(byTitle));
}

console.log(`Backup of «${meta.data.properties?.title}» (${titles.length} sheets) → ${dir}`);
for (const title of titles) console.log(`  ${title}`);

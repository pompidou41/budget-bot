import type { sheets_v4 } from 'googleapis';
import type { Account, Category, Reference } from '../domain/reference.js';
import { logger } from '../logger.js';

const ACCOUNTS_RANGE = 'Счета!A2:K';
// Per-category columns follow the flat A/B pairs after a blank spacer (D:S today)
// and end at the "CategoryList" column
const CATEGORIES_RANGE = 'Categories!C1:AZ';
const CATEGORY_LIST_HEADER = 'categorylist';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseAccounts(rows: unknown[][]): Account[] {
  return rows
    .filter((row) => text(row[0]))
    .map((row) => ({
      id: text(row[0]),
      name: text(row[1]),
      bank: text(row[2]),
      type: text(row[3]),
      currency: text(row[4]).toUpperCase(),
      group: text(row[5]),
      inCapital: row[6] === true,
      balance: numeric(row[9]),
      balanceUsd: numeric(row[10]),
    }));
}

export function parseCategories(rows: unknown[][]): Category[] {
  const header = rows[0] ?? [];
  const categories: Category[] = [];

  for (let col = 0; col < header.length; col++) {
    const name = text(header[col]);
    if (!name) {
      // Skip spacer columns before the first category, stop at a gap after them
      if (categories.length === 0) continue;
      break;
    }
    if (name.toLowerCase() === CATEGORY_LIST_HEADER) break;

    const subcategories = rows
      .slice(1)
      .map((row) => text(row[col]))
      .filter(Boolean);
    categories.push({ name, subcategories: [...new Set(subcategories)] });
  }

  return categories;
}

export interface ReferenceStore {
  /** Cached reference data, refreshed after TTL; falls back to stale data on errors. */
  get(): Promise<Reference>;
  /** Force re-read from the sheet (fresh balances, new accounts/categories). */
  reload(): Promise<Reference>;
}

export function createReferenceStore(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  ttlMs = DEFAULT_TTL_MS,
): ReferenceStore {
  let cached: { ref: Reference; loadedAt: number } | null = null;
  let inflight: Promise<Reference> | null = null;

  async function fetchReference(): Promise<Reference> {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [ACCOUNTS_RANGE, CATEGORIES_RANGE],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const [accounts, categories] = response.data.valueRanges ?? [];
    const ref: Reference = {
      accounts: parseAccounts((accounts?.values ?? []) as unknown[][]),
      categories: parseCategories((categories?.values ?? []) as unknown[][]),
    };

    if (ref.accounts.length === 0) {
      throw new Error(`No accounts found in ${ACCOUNTS_RANGE}`);
    }
    if (ref.categories.length === 0) {
      throw new Error(`No categories found in ${CATEGORIES_RANGE} (headers expected in row 1)`);
    }
    return ref;
  }

  function reload(): Promise<Reference> {
    inflight ??= fetchReference()
      .then((ref) => {
        cached = { ref, loadedAt: Date.now() };
        logger.info(
          { accounts: ref.accounts.length, categories: ref.categories.length },
          'Reference data loaded',
        );
        return ref;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function get(): Promise<Reference> {
    if (cached && Date.now() - cached.loadedAt < ttlMs) return cached.ref;
    try {
      return await reload();
    } catch (error) {
      if (!cached) throw error;
      logger.warn({ error }, 'Failed to refresh reference data, using stale copy');
      return cached.ref;
    }
  }

  return { get, reload };
}

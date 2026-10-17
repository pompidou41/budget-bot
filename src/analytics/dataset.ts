import type { sheets_v4 } from 'googleapis';
import { isIsoDate, serialToIso } from '../domain/dates.js';
import { OP_TYPES, type OpType } from '../domain/operation.js';
import { logger } from '../logger.js';

// A:L is what the bot writes (L = «Добавлено»), M:U are the sheet's own formulas — currency, rate, USD, month
const RANGE = 'Операции!A2:U';
// «Курсы»: H:I is the daily USD/RUB history (date | rate), A:E the table of current rates
const RATE_HISTORY_RANGE = 'Курсы!H4:I';
const RATES_RANGE = 'Курсы!A4:E';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** One row of «Операции» as analytics sees it: always dated, typed and priced in USD. */
export interface Txn {
  date: string; // A, YYYY-MM-DD
  month: string; // YYYY-MM, derived from date
  type: OpType; // B
  account: string; // C
  toAccount: string; // E
  amount: number; // D, in the account currency
  currency: string; // M
  usd: number; // O, always positive
  rub: number; // D if the account is in rubles, else usd × the day's USD/RUB rate
  category: string; // G
  subcategory: string; // H
  comment: string; // I
  oneOff: boolean; // J
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A sheet formula may still be erroring out («#N/A», «#ССЫЛКА!») — such a row is unusable
  return null;
}

/** Column A comes back as a serial with UNFORMATTED_VALUE, but tolerate typed dates too. */
export function cellToIso(value: unknown): string | null {
  const asNumber = numeric(value);
  if (asNumber !== null) return asNumber > 0 ? serialToIso(asNumber) : null;

  const raw = text(value);
  if (isIsoDate(raw)) return raw;

  const ru = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (!ru) return null;
  const iso = `${ru[3]}-${ru[2]!.padStart(2, '0')}-${ru[1]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

function isOpType(value: string): value is OpType {
  return (OP_TYPES as readonly string[]).includes(value);
}

/** USD/RUB by day from «Курсы», plus the current rate for dates the history does not reach. */
export interface RateTable {
  /** ISO dates, ascending. */
  dates: string[];
  /** USD/RUB on the date at the same index. */
  usdRub: number[];
  /** «Курсы».E of the RUB row. */
  current: number;
}

/**
 * Builds the rate table from `Курсы!H4:I` (date serial | rate) and `Курсы!A4:E`. Blank or
 * errored history rows are skipped. Without a current RUB rate the latest daily one stands in;
 * with neither, rubles come out as zeros — a broken «Курсы» must not take the USD analytics down.
 */
export function parseRateTable(history: unknown[][], currencies: unknown[][]): RateTable {
  const days: { date: string; rate: number }[] = [];
  for (const [date, rate] of history) {
    const serial = numeric(date);
    const value = numeric(rate);
    if (serial === null || serial <= 0 || value === null || value <= 0) continue;
    days.push({ date: serialToIso(serial), rate: value });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));

  const ruble = currencies.find((row) => text(row[0]).toUpperCase() === 'RUB');
  const quoted = numeric(ruble?.[4]);
  const current = quoted !== null && quoted > 0 ? quoted : (days.at(-1)?.rate ?? 0);
  if (current === 0) {
    logger.warn(`No USD/RUB rate in ${RATES_RANGE} or ${RATE_HISTORY_RANGE}, rubles will read 0`);
  }

  return { dates: days.map((d) => d.date), usdRub: days.map((d) => d.rate), current };
}

/**
 * USD/RUB for `date`: the latest daily rate on or before it, the way the sheet's own
 * `VLOOKUP(…, TRUE)` picks it, so a weekend or any gap takes the previous day's rate. Before
 * the history starts, the current rate stands in.
 */
export function usdRubOn(date: string, table: RateTable): number {
  let low = 0;
  let high = table.dates.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((table.dates[middle] ?? '') <= date) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return table.usdRub[found] ?? table.current;
}

/** Rows without a usable date, type or USD amount are dropped: analytics must not guess. */
export function parseTxns(rows: unknown[][], rates: RateTable): Txn[] {
  const txns: Txn[] = [];

  for (const row of rows) {
    const date = cellToIso(row[0]);
    const type = text(row[1]);
    if (!date || !isOpType(type)) continue;

    const amount = numeric(row[3]) ?? 0;
    const currency = text(row[12]).toUpperCase();
    // Column O is the sheet's own conversion; parity currencies can stand in if it is missing
    const usd = numeric(row[14]) ?? (currency === 'USD' || currency === 'USDT' ? amount : null);
    if (usd === null) continue;

    // Rubles for a GEL or USDT row are what the day's rate says, not a figure the sheet holds
    const rub = currency === 'RUB' ? Math.abs(amount) : Math.abs(usd) * usdRubOn(date, rates);

    txns.push({
      date,
      month: date.slice(0, 7),
      type,
      account: text(row[2]),
      toAccount: text(row[4]),
      amount,
      currency,
      usd: Math.abs(usd),
      rub,
      category: text(row[6]),
      subcategory: text(row[7]),
      comment: text(row[8]),
      oneOff: row[9] === true,
    });
  }

  return txns.sort((a, b) => a.date.localeCompare(b.date));
}

export interface DatasetStore {
  /** Cached history, refreshed after TTL; falls back to the stale copy on errors. */
  get(): Promise<Txn[]>;
  reload(): Promise<Txn[]>;
}

export function createDatasetStore(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  ttlMs = DEFAULT_TTL_MS,
): DatasetStore {
  let cached: { txns: Txn[]; loadedAt: number } | null = null;
  let inflight: Promise<Txn[]> | null = null;

  async function fetchTxns(): Promise<Txn[]> {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [RANGE, RATE_HISTORY_RANGE, RATES_RANGE],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const [operations, history, currencies] = response.data.valueRanges ?? [];
    const rates = parseRateTable(
      (history?.values ?? []) as unknown[][],
      (currencies?.values ?? []) as unknown[][],
    );
    return parseTxns((operations?.values ?? []) as unknown[][], rates);
  }

  function reload(): Promise<Txn[]> {
    inflight ??= fetchTxns()
      .then((txns) => {
        cached = { txns, loadedAt: Date.now() };
        logger.info({ operations: txns.length }, 'Operations history loaded');
        return txns;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function get(): Promise<Txn[]> {
    if (cached && Date.now() - cached.loadedAt < ttlMs) return cached.txns;
    try {
      return await reload();
    } catch (error) {
      if (!cached) throw error;
      logger.warn({ error }, 'Failed to refresh operations history, using stale copy');
      return cached.txns;
    }
  }

  return { get, reload };
}

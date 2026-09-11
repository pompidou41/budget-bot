import type { sheets_v4 } from 'googleapis';
import { isIsoDate, serialToIso } from '../domain/dates.js';
import { OP_TYPES, type OpType } from '../domain/operation.js';
import { logger } from '../logger.js';

// A:K is what the bot writes, L:T are the sheet's own formulas — currency, rate, USD, month
const RANGE = 'Операции!A2:T';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** One row of «Операции» as analytics sees it: always dated, typed and priced in USD. */
export interface Txn {
  date: string; // A, YYYY-MM-DD
  month: string; // YYYY-MM, derived from date
  type: OpType; // B
  account: string; // C
  toAccount: string; // E
  amount: number; // D, in the account currency
  currency: string; // L
  usd: number; // N, always positive
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

/** Rows without a usable date, type or USD amount are dropped: analytics must not guess. */
export function parseTxns(rows: unknown[][]): Txn[] {
  const txns: Txn[] = [];

  for (const row of rows) {
    const date = cellToIso(row[0]);
    const type = text(row[1]);
    if (!date || !isOpType(type)) continue;

    const amount = numeric(row[3]) ?? 0;
    const currency = text(row[11]).toUpperCase();
    // Column N is the sheet's own conversion; parity currencies can stand in if it is missing
    const usd = numeric(row[13]) ?? (currency === 'USD' || currency === 'USDT' ? amount : null);
    if (usd === null) continue;

    txns.push({
      date,
      month: date.slice(0, 7),
      type,
      account: text(row[2]),
      toAccount: text(row[4]),
      amount,
      currency,
      usd: Math.abs(usd),
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
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return parseTxns((response.data.values ?? []) as unknown[][]);
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

import type { sheets_v4 } from 'googleapis';
import { CAPITAL_SHEET, COL, GROUP_COLUMNS, LAST_VISIBLE, ROWS } from './capital-layout.js';
import { columnLetter } from './weeks-layout.js';

/** Rows read below the header: far more than the sheet ever holds (weekly points since 2026). */
const MAX_POINTS = 200;
/** Values under this are float noise from the sheet formulas (e.g. -5.68e-14). */
const NOISE = 0.5;

export interface CapitalLine {
  now: number;
  monthDelta: number;
  monthPct: number | null;
  startDelta: number;
  startPct: number | null;
}

export interface CapitalPoint {
  label: string;
  capital: number;
  capitalDelta: number | null;
  savings: number;
  savingsDelta: number | null;
}

/** What the sheet «Капитал» shows right now. The bot only reads it, never recomputes. */
export interface CapitalSnapshot {
  currency: string;
  note: string;
  /** Column headers of the month and since-start deltas, e.g. «За месяц (с 25.10)». */
  monthLabel: string;
  startLabel: string;
  capital: CapitalLine;
  savings: CapitalLine;
  points: CapitalPoint[];
  /** Groups of the «сейчас» row, in sheet order, zeros included. */
  groups: { name: string; value: number }[];
}

function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.abs(value) < NOISE ? 0 : value;
}

/** An empty Δ (first row) stays null; a percentage is a fraction, so no noise cut-off. */
function optional(value: unknown, cutNoise: boolean): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return cutNoise ? num(value) : value;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function summaryLine(row: unknown[] = []): CapitalLine {
  return {
    now: num(row[1]),
    monthDelta: num(row[2]),
    monthPct: optional(row[3], false),
    startDelta: num(row[4]),
    startPct: optional(row[5], false),
  };
}

/** Pure parse of the sheet rows (row 1 first, as returned from A1). Null when it is empty. */
export function parseCapital(rows: unknown[][]): CapitalSnapshot | null {
  const at = (row: number) => rows[row - 1] ?? [];
  const first = ROWS.first - 1;
  if (rows.length < first || text(at(ROWS.first)[COL.label]) === '') return null;

  const header = at(ROWS.header);
  const points: CapitalPoint[] = [];
  for (let r = ROWS.first; r < ROWS.first + MAX_POINTS; r++) {
    const row = at(r);
    const label = text(row[COL.label]);
    if (label === '') break;
    points.push({
      label,
      capital: num(row[COL.capital]),
      capitalDelta: optional(row[COL.capitalDelta], true),
      savings: num(row[COL.savings]),
      savingsDelta: optional(row[COL.savingsDelta], true),
    });
  }

  const nowRow = at(ROWS.first + points.length - 1);
  const groups = GROUP_COLUMNS.map((fallback, i) => ({
    name: text(header[COL.firstGroup + i]) || fallback,
    value: num(nowRow[COL.firstGroup + i]),
  }));

  const summary = at(ROWS.summaryHeader);
  return {
    currency: text(at(ROWS.currency)[1]) || 'USD',
    note: text(at(ROWS.title)[2]),
    monthLabel: text(summary[2]),
    startLabel: text(summary[4]),
    capital: summaryLine(at(ROWS.capital)),
    savings: summaryLine(at(ROWS.savings)),
    points,
    groups,
  };
}

function isMissingSheet(error: unknown): boolean {
  const e = error as { code?: number; message?: string };
  return e.code === 400 && /Unable to parse range/i.test(e.message ?? '');
}

/** Reads the computed values of «Капитал»; null when the sheet is not created yet. */
export async function readCapital(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<CapitalSnapshot | null> {
  const range = `'${CAPITAL_SHEET}'!A1:${columnLetter(LAST_VISIBLE)}${ROWS.header + MAX_POINTS}`;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    return parseCapital((response.data.values ?? []) as unknown[][]);
  } catch (error) {
    if (isMissingSheet(error)) return null;
    throw error;
  }
}

export interface CapitalStore {
  read(): Promise<CapitalSnapshot | null>;
}

export function createCapitalStore(sheets: sheets_v4.Sheets, spreadsheetId: string): CapitalStore {
  return { read: () => readCapital(sheets, spreadsheetId) };
}

import { isIsoDate } from '../domain/dates.js';

/** One line of a bank statement, as the bank printed it — nothing guessed yet. */
export interface StatementRow {
  /** 1-based position in the statement, used to refer back to it. */
  index: number;
  /** When the bank booked it. */
  postedDate: string;
  /** When it happened: a card payment's own date from its description, else postedDate. */
  date: string;
  direction: 'out' | 'in';
  amount: number;
  /** Running balance after this row, if the statement prints one. */
  balance: number | null;
  /** The bank's operation kind, often Georgian («საბარათე ოპერაცია»). */
  operation: string;
  description: string;
  counterparty: string;
  counterpartyAccount: string;
}

export interface Statement {
  holder: string;
  iban: string;
  currency: string;
  from: string | null;
  to: string | null;
  opening: number | null;
  closing: number | null;
  rows: StatementRow[];
}

export class StatementFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementFormatError';
  }
}

/** «1,140.84», «1 140,84» (any spaces), 1140.84 → 1140.84; anything else → null. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let raw = value.replace(/\s/g, '');
  if (!raw) return null;
  // «1.140,84» or «140,84»: comma is the decimal mark when it comes last
  if (/,\d{1,2}$/.test(raw)) raw = raw.replace(/\./g, '').replace(',', '.');
  else raw = raw.replace(/,/g, '');
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : null;
}

function fromDotted(text: string): string | null {
  const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  return isIsoDate(iso) ? iso : null;
}

/** A Date cell, an ISO string or «09.10.2026» → YYYY-MM-DD. */
export function parseStatementDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isIsoDate(text.slice(0, 10))) return text.slice(0, 10);
  return fromDotted(text);
}

/**
 * Card payments carry their own date at the end of the description
 * («გადახდა - spar 40.30 GEL 08.10.2026»); the booking date is often a day or two later.
 */
export function purchaseDate(description: string): string | null {
  const match = description.trim().match(/(\d{2}\.\d{2}\.\d{4})$/);
  return match?.[1] ? fromDotted(match[1]) : null;
}

const CENT = 0.005;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Checks the statement against its own arithmetic: every printed running balance must follow
 * from the previous one, and opening + turnover must give closing. This is what catches a row
 * misread from a PDF. Returns human-readable problems, empty when it adds up.
 */
export function verifyBalances(statement: Statement): string[] {
  const problems: string[] = [];
  let running = statement.opening;

  for (const row of statement.rows) {
    const delta = row.direction === 'in' ? row.amount : -row.amount;
    if (
      running !== null &&
      row.balance !== null &&
      Math.abs(running + delta - row.balance) > CENT
    ) {
      problems.push(
        `Строка ${row.index}: остаток ${row.balance}, а по расчёту ${round2(running + delta)}`,
      );
    }
    running = row.balance ?? (running === null ? null : running + delta);
  }

  if (statement.opening !== null && statement.closing !== null) {
    const turnover = statement.rows.reduce(
      (sum, row) => sum + (row.direction === 'in' ? row.amount : -row.amount),
      0,
    );
    if (Math.abs(statement.opening + turnover - statement.closing) > CENT) {
      problems.push(
        `Начальный остаток ${statement.opening} + обороты ${round2(turnover)} ≠ конечный ${statement.closing}`,
      );
    }
  }
  return problems;
}

/** Earliest and latest operation date — the stretch the statement speaks for. */
export function coveredDates(rows: StatementRow[]): { from: string; to: string } | null {
  if (rows.length === 0) return null;
  const dates = rows.map((row) => row.date).sort();
  return { from: dates[0]!, to: dates.at(-1)! };
}

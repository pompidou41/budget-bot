import {
  describeMatch,
  findDuplicates,
  type Duplicate,
  type Existing,
  type Movement,
} from '../domain/duplicates.js';
import {
  blankOperation,
  normalizeOperation,
  validate,
  type Operation,
  type OpType,
} from '../domain/operation.js';
import { findAccount, type Reference } from '../domain/reference.js';
import type { StatementRow } from './statement.js';

/** What the model made of one statement row. */
export interface RowGuess {
  type: OpType;
  /** The owner's other account of a transfer: where money went (out) or came from (in). */
  counterAccount: string | null;
  category: string | null;
  subcategory: string | null;
  comment: string;
  /** False when the model itself doubts the type or the category. */
  sure: boolean;
}

export type ItemStatus = 'ready' | 'doubtful' | 'recorded' | 'written' | 'drafted';

export interface ImportItem {
  /** StatementRow.index */
  row: number;
  op: Operation;
  status: ItemStatus;
  /** HTML: the recorded operation it repeats (recorded) or may repeat (doubtful). */
  duplicate?: string;
}

function currencyOf(ref: Reference, id: string | null): string | undefined {
  return id ? findAccount(ref, id)?.currency : undefined;
}

/** The model's type, unless it contradicts the direction: money in is never an expense. */
function typeOf(row: StatementRow, guess: RowGuess | undefined): OpType {
  const fallback: OpType = row.direction === 'out' ? 'Расход' : 'Доход';
  return guess && (guess.type === 'Перевод' || guess.type === fallback) ? guess.type : fallback;
}

function transferOf(row: StatementRow, base: Operation, other: string | null, ref: Reference) {
  // Outgoing: what landed on the other side in its own currency is not in this statement
  if (row.direction === 'out') return { ...base, toAccount: other };
  const sameCurrency = currencyOf(ref, other) === currencyOf(ref, base.account);
  return {
    ...base,
    account: other,
    amount: other && sameCurrency ? row.amount : null,
    toAccount: base.account,
    received: row.amount,
  };
}

/** A statement row as an operation on `account`; an incoming row may only be income or transfer. */
export function rowToOperation(
  row: StatementRow,
  guess: RowGuess | undefined,
  account: string,
  ref: Reference,
): Operation {
  const type = typeOf(row, guess);
  const base: Operation = {
    ...blankOperation(row.date, type),
    account,
    amount: row.amount,
    category: guess?.category ?? null,
    subcategory: guess?.subcategory ?? null,
    comment: guess?.comment ?? '',
  };
  if (type !== 'Перевод') return normalizeOperation(base, ref);
  return normalizeOperation(transferOf(row, base, guess?.counterAccount ?? null, ref), ref);
}

/** A statement row with the operation booked from it and whether the model is sure of it. */
export interface Booked {
  row: StatementRow;
  op: Operation;
  sure: boolean;
}

/** Only what the bank itself saw of a transfer: the other side is the model's guess. */
function bankSide(row: StatementRow, op: Operation): Movement {
  if (op.type !== 'Перевод') return op;
  return row.direction === 'out'
    ? { ...op, toAccount: null, received: null }
    : { ...op, account: null, amount: null };
}

function sourceRow(duplicate: Duplicate | null): number | undefined {
  return duplicate?.match.source.kind === 'row' ? duplicate.match.source.row : undefined;
}

/**
 * Matches with the model's guess of the other account first; a transfer that finds nothing that
 * way is tried again by the bank's own side alone — the owner may have booked it from elsewhere.
 */
function matchRecorded(booked: Booked[], recorded: Existing[]) {
  const found = findDuplicates(
    booked.map((b) => b.op),
    recorded,
  );
  const taken = new Set(found.map(sourceRow).filter((row) => row !== undefined));
  const retry = booked.flatMap((b, i) => (found[i] || b.op.type !== 'Перевод' ? [] : [i]));
  const again = findDuplicates(
    retry.map((i) => bankSide(booked[i]!.row, booked[i]!.op)),
    recorded.filter((r) => r.source.kind !== 'row' || !taken.has(r.source.row)),
  );
  retry.forEach((i, j) => {
    found[i] = again[j] ?? null;
  });
  return found;
}

/**
 * Sorts statement operations against the sheet: exact repeats are already recorded, possible
 * repeats, incomplete ones and the model's doubtful guesses go to the owner, the rest is ready.
 */
export function planImport(
  booked: Booked[],
  recorded: Existing[],
  ref: Reference,
): { items: ImportItem[]; matched: Set<number> } {
  const found = matchRecorded(booked, recorded);
  const matched = new Set<number>();
  const items = booked.map(({ row: statementRow, op, sure }, i): ImportItem => {
    const duplicate = found[i];
    const row = sourceRow(duplicate ?? null);
    if (row !== undefined) matched.add(row);
    const item: ImportItem = { row: statementRow.index, op, status: 'ready' };
    if (duplicate) item.duplicate = describeMatch(duplicate.match, ref);
    if (duplicate?.kind === 'exact') item.status = 'recorded';
    else if (duplicate || !sure || validate(op, ref).length > 0) item.status = 'doubtful';
    return item;
  });
  return { items, matched };
}

/** Sheet operations on the account within the statement's dates that the statement lacks. */
export function missingFromStatement(
  recorded: Existing[],
  matched: Set<number>,
  account: string,
  dates: { from: string; to: string },
): Existing[] {
  return recorded.filter(({ op, source }) => {
    if (source.kind !== 'row' || matched.has(source.row)) return false;
    if (op.date < dates.from || op.date > dates.to) return false;
    return op.account === account || op.toAccount === account;
  });
}

/** How an operation moves the balance of `account`. */
export function effectOn(op: Operation, account: string): number {
  let effect = 0;
  if (op.account === account) effect += op.type === 'Доход' ? (op.amount ?? 0) : -(op.amount ?? 0);
  if (op.type === 'Перевод' && op.toAccount === account) effect += op.received ?? op.amount ?? 0;
  return effect;
}

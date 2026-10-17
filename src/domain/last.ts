import { cellToIso } from '../analytics/dataset.js';
import { renderCard, TYPE_ICON } from './card.js';
import { formatDateRu, formatSerialDateTime, isoToSerial, weekday } from './dates.js';
import { escapeHtml, formatAmount } from './format.js';
import { OP_TYPES, type Operation, type OpType } from './operation.js';
import { findAccount, type Reference } from './reference.js';

// The pre-bot history rolled up by «week»: sums, not operations anyone entered
const ARCHIVE_ACCOUNT = 'ARCHIVE';
const LIST_LIMIT = 20;
const COMMENT_LIMIT = 40;

/** A row of «Операции» with where it sits and when it was entered. */
export interface SheetEntry {
  row: number; // 1-based
  op: Operation;
  /** «Добавлено» (L) as a serial; null for a row typed by hand after the migration. */
  addedAt: number | null;
}

export interface LastDay {
  /** The latest date up to today and every operation of it in the order entered: the newest last. */
  day: { date: string; entries: SheetEntry[] } | null;
  /** Operations dated after today stay out of the pick and are only counted. */
  future: { count: number; latest: string } | null;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isOpType(value: string): value is OpType {
  return (OP_TYPES as readonly string[]).includes(value);
}

/** A row read with UNFORMATTED_VALUE; null for blanks, ARCHIVE rows and rows without date or type. */
export function parseEntry(cells: unknown[], row: number): SheetEntry | null {
  const date = cellToIso(cells[0]);
  const type = text(cells[1]);
  const account = text(cells[2]);
  if (!date || !isOpType(type) || account === ARCHIVE_ACCOUNT) return null;

  return {
    row,
    addedAt: numeric(cells[11]),
    op: {
      date,
      type,
      account: account || null,
      amount: numeric(cells[3]),
      toAccount: text(cells[4]) || null,
      received: numeric(cells[5]),
      category: text(cells[6]) || null,
      subcategory: text(cells[7]) || null,
      comment: text(cells[8]),
      oneOff: cells[9] === true,
      manualRate: numeric(cells[10]),
      mentionedCurrency: null,
    },
  };
}

// A row without «Добавлено» counts as entered at the start of its own date, like the rows the
// migration backfilled; the row number settles ties. Not the row alone: the bot reuses gaps
// left by /undo, and the owner may sort the sheet.
function entryOrder(a: SheetEntry, b: SheetEntry): number {
  const at = (entry: SheetEntry) => entry.addedAt ?? isoToSerial(entry.op.date);
  return at(a) - at(b) || a.row - b.row;
}

function latestDate(entries: SheetEntry[]): string {
  return entries.reduce((latest, entry) => (entry.op.date > latest ? entry.op.date : latest), '');
}

/** `rows` = «Операции»!A:L from row 1, header included. */
export function findLastDay(rows: unknown[][], today: string): LastDay {
  const entries = rows.slice(1).flatMap((cells, i) => {
    const entry = parseEntry(cells ?? [], i + 2);
    return entry ? [entry] : [];
  });

  const ahead = entries.filter((entry) => entry.op.date > today);
  const future = ahead.length === 0 ? null : { count: ahead.length, latest: latestDate(ahead) };

  const past = entries.filter((entry) => entry.op.date <= today);
  if (past.length === 0) return { day: null, future };

  const date = latestDate(past);
  const day = past.filter((entry) => entry.op.date === date).sort(entryOrder);
  return { day: { date, entries: day }, future };
}

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

function shorten(value: string): string {
  return value.length > COMMENT_LIMIT ? `${value.slice(0, COMMENT_LIMIT - 1).trimEnd()}…` : value;
}

/** One line per operation: enough to find it in a bank statement. */
function entryLine({ op }: SheetEntry, ref: Reference): string {
  const currency = (op.account && findAccount(ref, op.account)?.currency) || '';
  const amount =
    op.amount === null ? '❓' : `${formatAmount(op.amount)}${currency ? ` ${currency}` : ''}`;
  const accounts =
    op.type === 'Перевод' && op.toAccount
      ? `${op.account ?? '❓'} → ${op.toAccount}`
      : (op.account ?? '❓');
  const what = op.comment || [op.category, op.subcategory].filter(Boolean).join(' › ');
  return (
    `${TYPE_ICON[op.type]} ${amount} · ${escapeHtml(accounts)}` +
    (what ? ` · ${escapeHtml(shorten(what))}` : '')
  );
}

// Rows the migration backfilled hold the bare date in «Добавлено»: no time worth showing
function hasTime(serial: number): boolean {
  return Math.round(serial * 86_400) % 86_400 !== 0;
}

/** HTML for /last: the newest operation of the latest date as a card, the rest of that day as lines. */
export function renderLastDay({ day, future }: LastDay, ref: Reference): string {
  const lines: string[] = [];

  if (!day) {
    lines.push('В «Операциях» нет записей с датой не позже сегодняшней.');
  } else {
    const newest = day.entries.at(-1)!;
    const earlier = day.entries.slice(0, -1);
    lines.push(`📍 Последняя дата: <b>${formatDateRu(day.date)} (${weekday(day.date)})</b>`, '');

    const facts = [
      earlier.length === 0
        ? 'Единственная за этот день'
        : `Внесена последней из ${day.entries.length} за этот день`,
      `строка ${newest.row}`,
    ];
    if (newest.addedAt !== null && hasTime(newest.addedAt)) {
      facts.push(`добавлена ${formatSerialDateTime(newest.addedAt)}`);
    }
    lines.push(renderCard(newest.op, ref, { footer: `<i>${facts.join(' · ')}</i>` }));

    if (earlier.length > 0) {
      const shown = earlier.slice(-LIST_LIMIT);
      lines.push('', `<b>Ещё за ${formatDateRu(day.date).slice(0, 5)}:</b>`);
      if (shown.length < earlier.length) {
        lines.push(`<i>…и ещё ${earlier.length - shown.length} внесены раньше</i>`);
      }
      lines.push(...shown.map((entry) => entryLine(entry, ref)));
    }
  }

  if (future) {
    const word = plural(future.count, 'операция', 'операции', 'операций');
    lines.push(
      '',
      `⏭ С датой позже сегодняшней: ${future.count} ${word}, последняя — ` +
        `${formatDateRu(future.latest)}. Здесь их не учитываю.`,
    );
  }

  return lines.join('\n');
}

const MS_PER_DAY = 86_400_000;
// Google Sheets serial dates count days from 1899-12-30
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function toUtcMs(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year ?? NaN, (month ?? NaN) - 1, day ?? NaN);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Current calendar date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addDays(iso: string, days: number): string {
  return fromUtcMs(toUtcMs(iso) + days * MS_PER_DAY);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = toUtcMs(value);
  return Number.isFinite(ms) && fromUtcMs(ms) === value;
}

export function weekday(iso: string): string {
  return WEEKDAYS[new Date(toUtcMs(iso)).getUTCDay()] ?? '';
}

export function formatDateRu(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

export function serialToIso(serial: number): string {
  return fromUtcMs(SHEETS_EPOCH_MS + Math.floor(serial) * MS_PER_DAY);
}

function compose(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Parse a user-typed date relative to `today`:
 * "сегодня", "вчера", "позавчера", "2026-09-05", "05.09.2026", "5.9.26", "05.09".
 */
export function parseUserDate(input: string, today: string): string | null {
  const text = input.trim().toLowerCase();
  if (text === 'сегодня') return today;
  if (text === 'вчера') return addDays(today, -1);
  if (text === 'позавчера') return addDays(today, -2);

  let iso: string | null = null;
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const ruMatch = text.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?$/);

  if (isoMatch) {
    iso = compose(isoMatch[1]!, isoMatch[2]!, isoMatch[3]!);
  } else if (ruMatch) {
    let year = ruMatch[3] ?? today.slice(0, 4);
    if (year.length === 2) year = `20${year}`;
    iso = compose(year, ruMatch[2]!, ruMatch[1]!);
  }

  return iso && isIsoDate(iso) ? iso : null;
}

import { addDays, weekday } from '../domain/dates.js';
import { findAccount, isArchived, type Account, type Reference } from '../domain/reference.js';
import type { Txn } from './dataset.js';
import { median, recordedPeriods, weekKey } from './queries.js';

/**
 * The human side of the numbers: which rows are real operations, what the comments say about
 * places and people, how money that came in was laid out, and which payments are obligations.
 * Pure functions; the review turns them into prompt text.
 */

// «Импорт из «копия Сводки»: Продукты» — rows carried over from the old summary sheet
const IMPORT_PREFIX = /^импорт из\s*«[^»]*»\s*:\s*/iu;

/** Money arriving below this is cashback or interest — noise in a story about income. */
const MIN_ARRIVAL_USD = 50;
/** Transfers this soon after money came in are read as laying that money out. */
const DISTRIBUTION_DAYS = 3;
const MIN_MOVE_USD = 50;

const MAX_PLACES = 5;
const MAX_OBLIGATIONS = 10;

/**
 * Bills rather than choices, by the sheet's own taxonomy (docs/SHEET_V2.md). Statistics could not
 * find them: most history is summaries with up to four rows a month per line, which makes rent
 * look exactly as "regular" as groceries. Education is left out on purpose — tuition and courses
 * can be either, and the owner can say which through an alias.
 */
const OBLIGATION_SUBCATEGORIES = new Set([
  'Rent',
  'Utilities',
  'Internet',
  'Mobile plan',
  'Car loan payment',
  'Car insurance',
  'Loan payment',
  'Interest paid',
  'Taxes',
]);
const OBLIGATION_CATEGORIES = new Set(['Subscriptions']);

/**
 * A summary row rather than an operation: the imported history holds period totals dated on
 * the 1st/9th/17th/25th, so one row can stand for a week of groceries. Such rows sum correctly
 * per month but say nothing about a single week, a purchase, a place or a person.
 */
export function isSummary(txn: Txn, ref: Reference): boolean {
  const account = findAccount(ref, txn.account);
  return (account !== undefined && isArchived(account)) || IMPORT_PREFIX.test(txn.comment);
}

/** The comment without the import prefix: «Импорт из «копия Сводки»: Квартира» → «Квартира». */
export function cleanComment(comment: string): string {
  return comment.replace(IMPORT_PREFIX, '').trim();
}

/**
 * Weeks that are really weeks: from the first real operation on, and holding no summary row.
 * An imported total dated the 17th makes its week look huge and the weeks around it empty,
 * which is exactly the jumpy weekly chart the owner noticed.
 */
export function liveWeeks(weeks: string[], txns: Txn[], ref: Reference): string[] {
  const live = txns.filter((t) => !isSummary(t, ref));
  const summaryWeeks = new Set(txns.filter((t) => isSummary(t, ref)).map((t) => weekKey(t.date)));
  return recordedPeriods(weeks, live, 'week').filter((key) => !summaryWeeks.has(key));
}

/**
 * A grouping key for places and people, so «Перевод Елизавета С.» and «Елизавета С.» are one
 * person and «Пятёрочка» matches «Пятерочка».
 */
export function normalizeComment(comment: string): string {
  return cleanComment(comment)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^(перевод(\s+от)?|оплата|покупка)\s+/u, '')
    .replace(/[«»"'.,:;!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Account names repeat across banks («Дебетовая карта»), so the bank tells them apart. */
function accountLabel(account: Account | undefined, id: string): string {
  if (!account) return id;
  return account.bank && !account.name.includes(account.bank)
    ? `${account.name}, ${account.bank}`
    : account.name;
}

// ─── money flow ────────────────────────────────────────────────────────────────────────

export interface MoneyMove {
  date: string;
  to: string;
  /** Group of the receiving account: «Накопления», «Ежемесячные»… */
  group: string;
  usd: number;
}

export interface MoneyArrival {
  date: string;
  /** What came in, in the owner's words where there are any: «Зарплата», «Перевод от Джалил А.». */
  what: string;
  isSalary: boolean;
  /** Where it landed; empty for summary rows, whose account is the archive, not a real one. */
  account: string;
  usd: number;
  /** Transfers made within a few days after it — how this money was laid out. */
  moves: MoneyMove[];
}

/**
 * Income in [from, to] with the transfers that followed it. There is deliberately no notion of
 * a pay schedule: the owner's schedule changes, so the review only states what already happened.
 */
export function moneyFlow(txns: Txn[], ref: Reference, from: string, to: string): MoneyArrival[] {
  const arrivals: MoneyArrival[] = txns
    .filter((t) => t.type === 'Доход' && t.date >= from && t.date <= to && t.usd >= MIN_ARRIVAL_USD)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => ({
      date: t.date,
      what: cleanComment(t.comment) || t.subcategory || t.category,
      isSalary: t.subcategory.toLowerCase() === 'salary',
      account: isSummary(t, ref) ? '' : accountLabel(findAccount(ref, t.account), t.account),
      usd: t.usd,
      moves: [],
    }));

  const moves = txns
    .filter((t) => t.type === 'Перевод' && t.usd >= MIN_MOVE_USD && !isSummary(t, ref))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const move of moves) {
    // A transfer belongs to the latest money that arrived before it, if that was recent enough
    const owner = [...arrivals]
      .reverse()
      .find((a) => a.date <= move.date && move.date <= addDays(a.date, DISTRIBUTION_DAYS));
    if (!owner) continue;
    const target = findAccount(ref, move.toAccount);
    owner.moves.push({
      date: move.date,
      to: accountLabel(target, move.toAccount),
      group: target?.group ?? '',
      usd: move.usd,
    });
  }

  return arrivals;
}

/** Days from the latest salary on or before `today`; undefined if there is none on record. */
export function daysSinceSalary(txns: Txn[], today: string): number | undefined {
  let latest: string | undefined;
  for (const t of txns) {
    if (t.type !== 'Доход' || t.subcategory.toLowerCase() !== 'salary' || t.date > today) continue;
    if (latest === undefined || t.date > latest) latest = t.date;
  }
  if (latest === undefined) return undefined;
  return Math.round((Date.parse(today) - Date.parse(latest)) / 86_400_000);
}

// ─── places, people, subcategories ─────────────────────────────────────────────────────

export interface PlaceShare {
  /** The comment as the owner wrote it the first time: «Елизавета С.». */
  label: string;
  count: number;
  usd: number;
}

export interface SubcategoryShare {
  name: string;
  actual: number;
  /** Usual per period; null when there are no real operations with subcategories to compare. */
  typical: number | null;
}

export interface CategoryComposition {
  category: string;
  subcategories: SubcategoryShare[];
  /** Where and to whom the money went this period, from real operations only. */
  places: PlaceShare[];
}

/**
 * What a category is made of this period. `current` is the category's spending in the reviewed
 * period; `baseline` holds its spending per earlier period, oldest first.
 */
export function composition(
  category: string,
  current: Txn[],
  baseline: Txn[][],
  ref: Reference,
): CategoryComposition {
  // Summaries use the old sheet's lines («Еда вне дома»), not today's subcategories: comparing
  // against them would call every café visit new
  const comparable = baseline.some((period) =>
    period.some((t) => t.subcategory && !isSummary(t, ref)),
  );

  const names = new Set(current.map((t) => t.subcategory || '—'));
  const subcategories = [...names]
    .map((name): SubcategoryShare => {
      const matches = (t: Txn) => (t.subcategory || '—') === name;
      const sum = (list: Txn[]) => list.filter(matches).reduce((total, t) => total + t.usd, 0);
      return {
        name,
        actual: sum(current),
        typical: comparable ? median(baseline.map(sum)) : null,
      };
    })
    .sort((a, b) => b.actual - a.actual);

  const places = new Map<string, PlaceShare>();
  for (const t of current) {
    if (isSummary(t, ref)) continue;
    const key = normalizeComment(t.comment);
    if (!key) continue;
    const place = places.get(key) ?? { label: cleanComment(t.comment), count: 0, usd: 0 };
    place.count++;
    place.usd += t.usd;
    places.set(key, place);
  }

  return {
    category,
    subcategories,
    places: [...places.values()].sort((a, b) => b.usd - a.usd).slice(0, MAX_PLACES),
  };
}

// ─── obligations ───────────────────────────────────────────────────────────────────────

export interface Obligation {
  key: string;
  label: string;
  category: string;
  monthsSeen: number;
  typicalMonthly: number;
}

/** Which bill an expense pays, or null when it is an ordinary choice rather than an obligation. */
export function obligationKey(txn: Txn): string | null {
  if (txn.type !== 'Расход' || txn.oneOff) return null;
  if (OBLIGATION_SUBCATEGORIES.has(txn.subcategory)) return `${txn.category}/${txn.subcategory}`;
  if (OBLIGATION_CATEGORIES.has(txn.category)) return txn.category;
  return null;
}

/**
 * Obligations over `months` with what they usually cost a month. Amounts are summed per month
 * first, so four summary rows of subscriptions and one real payment compare fairly.
 */
export function obligations(txns: Txn[], months: string[]): Obligation[] {
  const window = new Set(months);
  const byKey = new Map<
    string,
    { label: string; category: string; perMonth: Map<string, number> }
  >();

  for (const t of txns) {
    if (!window.has(t.month)) continue;
    const key = obligationKey(t);
    if (!key) continue;
    const entry = byKey.get(key) ?? {
      label: '',
      category: t.category,
      perMonth: new Map<string, number>(),
    };
    entry.perMonth.set(t.month, (entry.perMonth.get(t.month) ?? 0) + t.usd);
    // A named bill keeps the owner's latest wording («Квартира»); a whole category keeps its name,
    // since one merchant's comment would mislabel all of its subscriptions
    entry.label = OBLIGATION_SUBCATEGORIES.has(t.subcategory)
      ? cleanComment(t.comment) || t.subcategory
      : t.category;
    byKey.set(key, entry);
  }

  return (
    [...byKey]
      // One month is a payment, not yet a usual cost
      .filter(([, entry]) => entry.perMonth.size >= 2)
      .map(([key, entry]) => ({
        key,
        label: entry.label,
        category: entry.category,
        monthsSeen: entry.perMonth.size,
        typicalMonthly: median([...entry.perMonth.values()]),
      }))
      .sort((a, b) => b.typicalMonthly - a.typicalMonthly)
      .slice(0, MAX_OBLIGATIONS)
  );
}

// ─── timeline ──────────────────────────────────────────────────────────────────────────

function dayLabel(iso: string): string {
  return `${weekday(iso)} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

/**
 * Day-by-day operations of a short period, so the model can notice what goes together —
 * flowers, wine and a transfer to the same person on one Saturday. Summary rows are left out.
 * Over the limit, each day collapses into totals per category.
 */
export function timeline(
  txns: Txn[],
  ref: Reference,
  from: string,
  to: string,
  maxLines = 60,
): string[] {
  const rows = txns
    .filter(
      (t) =>
        (t.type === 'Расход' || t.type === 'Доход') &&
        t.date >= from &&
        t.date <= to &&
        !isSummary(t, ref),
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  const detailed = rows.map((t) =>
    [
      dayLabel(t.date),
      `${t.type === 'Доход' ? '+' : ''}${t.category}${t.subcategory ? `/${t.subcategory}` : ''}`,
      `$${Math.round(t.usd)}`,
      cleanComment(t.comment),
      t.oneOff ? 'разовая' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (detailed.length <= maxLines) return detailed;

  const days = new Map<string, Map<string, { usd: number; count: number }>>();
  for (const t of rows) {
    const day = days.get(t.date) ?? new Map<string, { usd: number; count: number }>();
    const name = `${t.type === 'Доход' ? '+' : ''}${t.category}`;
    const cell = day.get(name) ?? { usd: 0, count: 0 };
    cell.usd += t.usd;
    cell.count++;
    day.set(name, cell);
    days.set(t.date, day);
  }

  return [...days]
    .map(
      ([date, day]) =>
        `${dayLabel(date)} · ${[...day]
          .sort((a, b) => b[1].usd - a[1].usd)
          .map(([name, cell]) => `${name} $${Math.round(cell.usd)} (${cell.count})`)
          .join(', ')}`,
    )
    .slice(-maxLines);
}

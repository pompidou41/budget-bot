import { isIsoDate, serialToIso } from './dates.js';
import {
  findAccount,
  findCategory,
  isArchived,
  TRANSFER_CATEGORY,
  type Reference,
} from './reference.js';

export const OP_TYPES = ['Расход', 'Доход', 'Перевод'] as const;
export type OpType = (typeof OP_TYPES)[number];
export type CellValue = string | number | boolean;

/** One row of «Операции» (columns A:K), plus fields the bot needs while drafting. */
export interface Operation {
  date: string; // A, YYYY-MM-DD
  type: OpType; // B
  account: string | null; // C, null = not chosen yet
  amount: number | null; // D, in account currency
  toAccount: string | null; // E, transfers only
  received: number | null; // F, transfers only; required when currencies differ
  category: string | null; // G
  subcategory: string | null; // H
  comment: string; // I
  oneOff: boolean; // J
  manualRate: number | null; // K
  mentionedCurrency: string | null; // not written; currency the user named the amount in
}

export function blankOperation(date: string, type: OpType = 'Расход'): Operation {
  return {
    date,
    type,
    account: null,
    amount: null,
    toAccount: null,
    received: null,
    category: null,
    subcategory: null,
    comment: '',
    oneOff: false,
    manualRate: null,
    mentionedCurrency: null,
  };
}

/** Keeps fields consistent with the operation type and the chosen category. */
export function normalizeOperation(op: Operation, ref: Reference): Operation {
  const next = { ...op };

  if (next.type !== 'Перевод') {
    next.toAccount = null;
    next.received = null;
    if (next.category === TRANSFER_CATEGORY) {
      next.category = null;
      next.subcategory = null;
    }
  } else if (!next.category && findCategory(ref, TRANSFER_CATEGORY)) {
    next.category = TRANSFER_CATEGORY;
  }

  if (next.category && next.subcategory) {
    const category = findCategory(ref, next.category);
    if (!category?.subcategories.includes(next.subcategory)) next.subcategory = null;
  }

  return next;
}

// USDT is kept at 1:1 with USD in the sheet, so naming "$" for a USDT account is fine
function sameMoney(a: string, b: string): boolean {
  const unify = (c: string) => (c === 'USDT' ? 'USD' : c);
  return unify(a) === unify(b);
}

/**
 * Put the owner's default payment account into an expense that didn't name one (/settings).
 * Incomes and transfers are left alone — there the account is never a safe guess.
 * A default in another currency than the named amount is skipped too, so `validate` keeps asking.
 */
export function applyDefaultAccount(
  op: Operation,
  defaultAccount: string | null,
  ref: Reference,
): Operation {
  if (op.type !== 'Расход' || op.account !== null || !defaultAccount) return op;

  const account = findAccount(ref, defaultAccount);
  if (!account || isArchived(account)) return op;
  if (op.mentionedCurrency && !sameMoney(op.mentionedCurrency, account.currency)) return op;

  return { ...op, account: account.id };
}

/** Human-readable list of reasons the operation cannot be saved yet. */
export function validate(op: Operation, ref: Reference): string[] {
  const problems: string[] = [];
  const account = op.account ? findAccount(ref, op.account) : undefined;

  if (!isIsoDate(op.date)) problems.push('Некорректная дата');

  if (!op.account) {
    problems.push(op.type === 'Доход' ? 'Не выбран счёт зачисления' : 'Не выбран счёт');
  } else if (!account) {
    problems.push(`Счёта ${op.account} нет в листе «Счета»`);
  } else if (isArchived(account)) {
    problems.push(`Счёт ${op.account} архивный`);
  }

  if (op.amount === null || !(op.amount > 0)) problems.push('Не указана сумма');

  if (op.type === 'Перевод') {
    const to = op.toAccount ? findAccount(ref, op.toAccount) : undefined;
    if (!op.toAccount) {
      problems.push('Не выбран счёт получения');
    } else if (!to) {
      problems.push(`Счёта ${op.toAccount} нет в листе «Счета»`);
    } else if (isArchived(to)) {
      problems.push(`Счёт ${op.toAccount} архивный`);
    } else if (op.toAccount === op.account) {
      problems.push('Счета отправления и получения совпадают');
    } else if (account && to.currency !== account.currency && op.received === null) {
      problems.push(`Укажи, сколько пришло на ${to.id} в ${to.currency}`);
    }
  }
  if (op.received !== null && !(op.received > 0)) {
    problems.push('Полученная сумма должна быть больше нуля');
  }

  if (!op.category) {
    problems.push('Не выбрана категория');
  } else {
    const category = findCategory(ref, op.category);
    if (!category) {
      problems.push(`Категории ${op.category} нет в листе «Categories»`);
    } else if (op.subcategory && !category.subcategories.includes(op.subcategory)) {
      problems.push(`Подкатегории ${op.subcategory} нет в категории ${op.category}`);
    } else if (!op.subcategory && category.subcategories.length > 0) {
      problems.push('Не выбрана подкатегория');
    }
  }

  if (account && op.mentionedCurrency && !sameMoney(op.mentionedCurrency, account.currency)) {
    problems.push(
      `Сумма названа в ${op.mentionedCurrency}, а счёт ${account.id} в ${account.currency} — ` +
        `напиши сумму в ${account.currency}`,
    );
  }

  if (op.manualRate !== null && !(op.manualRate > 0)) {
    problems.push('Курс должен быть больше нуля');
  }

  return problems;
}

// USER_ENTERED would turn "=…", "+…", "-…", "@…" into formulas; a leading apostrophe forces text
function asText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** Values for «Операции»!A:K. Call only for operations that passed validate(). */
export function toRow(op: Operation): CellValue[] {
  if (!op.account || op.amount === null || !op.category) {
    throw new Error('Operation is incomplete');
  }
  return [
    op.date,
    op.type,
    op.account,
    op.amount,
    op.toAccount ?? '',
    op.received ?? '',
    asText(op.category),
    asText(op.subcategory ?? ''),
    asText(op.comment),
    op.oneOff,
    op.manualRate ?? '',
  ];
}

function normalizeCell(value: unknown, column: number): string {
  if (value === undefined || value === null || value === '' || value === false) return '';
  if (column === 0 && typeof value === 'number') return serialToIso(value);
  if (typeof value === 'string') return value.replace(/^'/, '').trim();
  return String(value);
}

/**
 * Whether a row read back with UNFORMATTED_VALUE still holds what the bot wrote.
 * Tolerates serial dates, trimmed trailing cells and the text-forcing apostrophe.
 */
export function rowMatches(written: CellValue[], actual: unknown[]): boolean {
  return written.every((cell, i) => normalizeCell(cell, i) === normalizeCell(actual[i], i));
}

import type { Operation } from './operation.js';
import { findAccount, type Account, type Reference } from './reference.js';

/**
 * How an exchange rate between two currencies is quoted: `quote` units per 1 `base`.
 * `forward` means base is the source currency, so received = amount × rate.
 */
export interface ExchangeQuote {
  base: string;
  quote: string;
  forward: boolean;
}

/** USD worth of one unit, read off the account's own balance columns (J and K of «Счета»). */
function usdPerUnit(account: Account): number | null {
  if (!account.balance || !account.balanceUsd) return null;
  const value = account.balanceUsd / account.balance;
  return value > 0 ? value : null;
}

function accountsOf(op: Operation, ref: Reference): [Account, Account] | null {
  if (op.type !== 'Перевод' || !op.account || !op.toAccount) return null;
  const from = findAccount(ref, op.account);
  const to = findAccount(ref, op.toAccount);
  return from && to ? [from, to] : null;
}

/** Whether the transfer changes currency, so «Получено» (F) has to be filled. */
export function isExchange(op: Operation, ref: Reference): boolean {
  const pair = accountsOf(op, ref);
  return pair !== null && pair[0].currency !== pair[1].currency;
}

/**
 * The way people say the rate aloud: the dearer currency is the base, so «3,1» for EUR → GEL
 * and «90» for RUB → USD alike. Without balances to compare, per 1 unit of the source.
 */
export function exchangeQuote(op: Operation, ref: Reference): ExchangeQuote | null {
  const pair = accountsOf(op, ref);
  if (!pair || pair[0].currency === pair[1].currency) return null;
  const [from, to] = pair;
  const fromUsd = usdPerUnit(from);
  const toUsd = usdPerUnit(to);
  const forward = fromUsd === null || toUsd === null || fromUsd >= toUsd;
  return forward
    ? { base: from.currency, quote: to.currency, forward }
    : { base: to.currency, quote: from.currency, forward };
}

/** «Получено» for the given rate, rounded to cents. */
export function receivedAtRate(amount: number, rate: number, quote: ExchangeQuote): number {
  const received = quote.forward ? amount * rate : amount / rate;
  return Math.round(received * 100) / 100;
}

/** The rate implied by amount and received, in the same quoting as `exchangeQuote`. */
export function impliedRate(op: Operation, quote: ExchangeQuote): number | null {
  if (!op.amount || !op.received) return null;
  const rate = quote.forward ? op.received / op.amount : op.amount / op.received;
  return Math.round(rate * 10000) / 10000;
}

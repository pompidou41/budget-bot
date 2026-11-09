import { activeAccounts, type Account, type Reference } from '../domain/reference.js';
import type { Statement } from './statement.js';

// Georgian IBANs carry the bank in characters 5–6: GE16 CD 0360000075695969
const GEORGIAN_BANKS: Record<string, RegExp> = {
  CD: /credo|кредо/i,
  BG: /bank of georgia|\bbog\b|банк грузии/i,
  TB: /\btbc\b/i,
  LB: /liberty/i,
};

export interface AccountChoice {
  /** The single account the statement belongs to, if it is beyond doubt. */
  account: string | null;
  /** Accounts to offer when it is not: the bank's in that currency, else all in that currency. */
  candidates: Account[];
}

function bankPattern(iban: string): RegExp | undefined {
  const match = iban.toUpperCase().match(/^GE\d{2}([A-Z]{2})/);
  return match?.[1] ? GEORGIAN_BANKS[match[1]] : undefined;
}

/** Picks the «Счета» row a statement belongs to by its bank and currency — never by currency alone. */
export function resolveAccount(
  statement: Pick<Statement, 'iban' | 'currency'>,
  ref: Reference,
): AccountChoice {
  const inCurrency = activeAccounts(ref).filter((a) => a.currency === statement.currency);
  const pattern = bankPattern(statement.iban);
  const atBank = pattern
    ? inCurrency.filter((a) => pattern.test(a.bank) || pattern.test(a.name) || pattern.test(a.id))
    : [];
  if (atBank.length === 1) return { account: atBank[0]!.id, candidates: atBank };
  return { account: null, candidates: atBank.length > 0 ? atBank : inCurrency };
}

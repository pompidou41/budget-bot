/** Row of the «Счета» sheet. */
export interface Account {
  id: string;
  name: string;
  bank: string;
  type: string;
  currency: string;
  group: string;
  inCapital: boolean;
  balance: number | null;
  balanceUsd: number | null;
}

/** Top-level category from «Categories» (C:R headers) with its subcategories. */
export interface Category {
  name: string;
  subcategories: string[];
}

export interface Reference {
  accounts: Account[];
  categories: Category[];
}

const ARCHIVE = 'Архив';
export const TRANSFER_CATEGORY = 'Transfer';

export function isArchived(account: Account): boolean {
  return account.type === ARCHIVE || account.group.startsWith(ARCHIVE);
}

/** Accounts that may be used in new operations (archive excluded). */
export function activeAccounts(ref: Reference): Account[] {
  return ref.accounts.filter((a) => !isArchived(a));
}

export function findAccount(ref: Reference, id: string): Account | undefined {
  return ref.accounts.find((a) => a.id === id);
}

export function findCategory(ref: Reference, name: string): Category | undefined {
  return ref.categories.find((c) => c.name === name);
}

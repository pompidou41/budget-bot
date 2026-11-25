import { categoryLabel } from './category-labels.js';
import { escapeHtml, formatAmount } from './format.js';
import { blankOperation, type Operation } from './operation.js';
import { activeSettlements, type Account, type Reference } from './reference.js';

/**
 * A person on a settlement account (LIZA_GEL ↔ category Liza) never owes the owner: whatever he
 * sends beyond what they spent for him is their pocket money. Such accounts are found by the
 * category named like the account's prefix that has this subcategory.
 */
export const ALLOWANCE_SUBCATEGORY = 'Allowance';
export const ALLOWANCE_COMMENT = 'Излишек переводов — на личные траты';

export interface Surplus {
  account: Account;
  category: string;
  /** In the account's currency, rounded to cents; always positive. */
  amount: number;
}

/** The person's category for a settlement account, when its surplus is pocket money. */
export function allowanceCategory(account: Account, ref: Reference): string | null {
  const prefix = account.id.split('_')[0]?.toLowerCase();
  const category = ref.categories.find(
    (c) => c.name.toLowerCase() === prefix && c.subcategories.includes(ALLOWANCE_SUBCATEGORY),
  );
  return category?.name ?? null;
}

/** Settlement accounts in plus that should never be: the owner sent more than was spent for him. */
export function findSurpluses(ref: Reference): Surplus[] {
  return activeSettlements(ref).flatMap((account) => {
    const category = allowanceCategory(account, ref);
    const amount = Math.round((account.balance ?? 0) * 100) / 100;
    return category && amount > 0 ? [{ account, category, amount }] : [];
  });
}

/** The expense that turns the surplus into the person's pocket money and brings the account to 0. */
export function allowanceOperation(surplus: Surplus, date: string): Operation {
  return {
    ...blankOperation(date, 'Расход'),
    account: surplus.account.id,
    amount: surplus.amount,
    category: surplus.category,
    subcategory: ALLOWANCE_SUBCATEGORY,
    comment: ALLOWANCE_COMMENT,
  };
}

/** The amount in cents travels in the callback, so a press never books a stale surplus. */
export function surplusCents(surplus: Pick<Surplus, 'amount'>): number {
  return Math.round(surplus.amount * 100);
}

export function renderSurplusOffer(surplus: Surplus): string {
  const who = escapeHtml(categoryLabel(surplus.category));
  const amount = `${formatAmount(surplus.amount)} ${escapeHtml(surplus.account.currency)}`;
  return (
    `💝 <b>${who}: плюс ${amount}</b>\n` +
    'Переведено больше, чем было потрачено за тебя. Это не долг — записать излишек ' +
    `на личные траты (${who} › ${ALLOWANCE_SUBCATEGORY})?`
  );
}

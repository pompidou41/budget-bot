import type { Operation } from './operation.js';
import {
  findCategory,
  SETTLEMENT_SUBCATEGORY,
  TRANSFER_CATEGORY,
  type Account,
  type Reference,
} from './reference.js';

/**
 * Turns an expense or income into a transfer to/from a settlement account: money that goes
 * back and forth with a person changes who owes whom, it is not spending or earning.
 * Returns null for a transfer, which has nothing to convert.
 */
export function toSettlement(op: Operation, settlement: Account, ref: Reference): Operation | null {
  if (op.type === 'Перевод') return null;

  const transfer = findCategory(ref, TRANSFER_CATEGORY);
  const category = transfer ? TRANSFER_CATEGORY : null;
  const subcategory = transfer?.subcategories.includes(SETTLEMENT_SUBCATEGORY)
    ? SETTLEMENT_SUBCATEGORY
    : null;
  const base = { ...op, type: 'Перевод' as const, category, subcategory, received: null };

  if (op.type === 'Расход') return { ...base, toAccount: settlement.id };

  // Income: the amount was in the receiving account's currency, which now is the «received» side.
  const to = op.account ? ref.accounts.find((a) => a.id === op.account) : undefined;
  const crossCurrency = to !== undefined && to.currency !== settlement.currency;
  return {
    ...base,
    account: settlement.id,
    toAccount: op.account,
    ...(crossCurrency ? { amount: null, received: op.amount, mentionedCurrency: null } : {}),
  };
}

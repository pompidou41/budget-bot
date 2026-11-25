import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/bot/deps.js';
import { allowanceOperation, findSurpluses, renderSurplusOffer } from '../src/domain/allowance.js';
import { validate } from '../src/domain/operation.js';
import type { Account, Reference } from '../src/domain/reference.js';
import { ref as baseRef } from './fixtures.js';
import { deps, press, testBot, type Call } from './statement-bot.js';

function settlement(id: string, balance: number | null): Account {
  return {
    id,
    name: id,
    bank: '',
    type: 'Расчёты',
    currency: 'GEL',
    group: 'Расчёты',
    inCapital: true,
    balance,
    balanceUsd: null,
  };
}

function withBalances(liza: number | null, debts = 50): Reference {
  return {
    accounts: [...baseRef.accounts, settlement('LIZA_GEL', liza), settlement('DEBTS_GEL', debts)],
    categories: [...baseRef.categories, { name: 'Liza', subcategories: ['Gifts', 'Allowance'] }],
  };
}

describe('surplus on a settlement account', () => {
  it('is pocket money only for an account with the person’s Allowance category', () => {
    const surpluses = findSurpluses(withBalances(36.0300000001));
    // DEBTS_GEL has no «Debts › Allowance» category: people there may really owe the owner
    expect(surpluses.map((s) => [s.account.id, s.category, s.amount])).toEqual([
      ['LIZA_GEL', 'Liza', 36.03],
    ]);
  });

  it('is nothing when the account is settled or the owner owes', () => {
    expect(findSurpluses(withBalances(0.004))).toEqual([]);
    expect(findSurpluses(withBalances(-210.52))).toEqual([]);
    expect(findSurpluses(withBalances(null))).toEqual([]);
  });

  it('books a valid Liza › Allowance expense on the settlement account', () => {
    const ref = withBalances(36.03);
    const op = allowanceOperation(findSurpluses(ref)[0]!, '2026-11-25');
    expect(op).toMatchObject({
      type: 'Расход',
      account: 'LIZA_GEL',
      amount: 36.03,
      category: 'Liza',
      subcategory: 'Allowance',
    });
    expect(validate(op, ref)).toEqual([]);
    expect(renderSurplusOffer(findSurpluses(ref)[0]!)).toContain('Лиза: плюс 36,03 GEL');
  });
});

function setup(liza: number) {
  const base = deps();
  const ref = withBalances(liza);
  const appDeps = {
    ...base,
    refs: { get: async () => ref, reload: async () => ref },
  } as unknown as AppDeps;
  return { appDeps, ...testBot(appDeps) };
}

const lastEdit = (calls: Call[]) => calls.filter((c) => c.method === 'editMessageText').at(-1)!;

describe('allowance button', () => {
  it('writes the surplus the offer showed', async () => {
    const { appDeps, bot, calls } = setup(36.03);
    await bot.handleUpdate(press('al:LIZA_GEL:3603', 70));
    const [values] = (appDeps.repo.append as unknown as { mock: { calls: unknown[][][] } }).mock
      .calls[0]!;
    expect(values!.slice(1, 9)).toEqual([
      'Расход',
      'LIZA_GEL',
      36.03,
      '',
      '',
      'Liza',
      'Allowance',
      'Излишек переводов — на личные траты',
    ]);
    expect(appDeps.journal.add).toHaveBeenCalled();
    expect(String(lastEdit(calls).payload.text)).toContain('Записано');
  });

  it('shows the new amount instead of booking a stale one', async () => {
    const { appDeps, bot, calls } = setup(50);
    await bot.handleUpdate(press('al:LIZA_GEL:3603', 70));
    expect(appDeps.repo.append).not.toHaveBeenCalled();
    expect(String(lastEdit(calls).payload.text)).toContain('плюс 50 GEL');
    expect(JSON.stringify(lastEdit(calls).payload.reply_markup)).toContain('al:LIZA_GEL:5000');
  });

  it('writes nothing once the account is settled', async () => {
    const { appDeps, bot, calls } = setup(0);
    await bot.handleUpdate(press('al:LIZA_GEL:3603', 70));
    expect(appDeps.repo.append).not.toHaveBeenCalled();
    expect(String(lastEdit(calls).payload.text)).toContain('Уже в расчёте');
  });
});

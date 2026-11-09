import type { Reference } from '../src/domain/reference.js';
import type { RowGuess } from '../src/statement/plan.js';
import type { StatementRow } from '../src/statement/statement.js';
import { ref as baseRef } from './fixtures.js';

/** The base reference plus the Credo accounts and a lari cash wallet. */
export const ref: Reference = {
  ...baseRef,
  accounts: [
    ...baseRef.accounts,
    ...(['CREDO_GEL:GEL', 'CREDO_USD:USD', 'CASH_GEL:GEL'] as const).map((spec) => {
      const [id, currency] = spec.split(':') as [string, string];
      return {
        id,
        name: id.startsWith('CREDO') ? 'Дебетовая карта Credo Bank' : 'Наличные лари',
        bank: id.startsWith('CREDO') ? 'Credo Bank' : 'Кошелёк',
        type: 'Карта',
        currency,
        group: 'Текущие',
        inCapital: true,
        balance: 100,
        balanceUsd: null,
      };
    }),
  ],
};

export function statementRow(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    index: 1,
    postedDate: '2026-10-10',
    date: '2026-10-09',
    direction: 'out',
    amount: 27.06,
    balance: null,
    operation: 'საბარათე ოპერაცია',
    description: 'გადახდა - spar 27.06 GEL 09.10.2026',
    counterparty: '',
    counterpartyAccount: '',
    ...overrides,
  };
}

export function guess(overrides: Partial<RowGuess> = {}): RowGuess {
  return {
    type: 'Расход',
    counterAccount: null,
    category: 'Food',
    subcategory: 'Groceries',
    comment: 'Spar',
    sure: true,
    ...overrides,
  };
}

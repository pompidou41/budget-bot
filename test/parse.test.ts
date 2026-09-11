import { describe, expect, it } from 'vitest';
import {
  aiResponseSchema,
  buildResponseSchema,
  categoryPairs,
  fromAiOperation,
  toAiOperation,
} from '../src/ai/parse.js';
import { parseJsonContent } from '../src/ai/openrouter.js';
import { expense, ref } from './fixtures.js';

const today = '2026-09-11';

describe('buildResponseSchema', () => {
  const schema = buildResponseSchema(ref).schema as {
    properties: { operations: { items: { properties: Record<string, { enum?: string[] }> } } };
  };
  const props = schema.properties.operations.items.properties;

  it('offers only active accounts plus NONE', () => {
    expect(props.account?.enum).toEqual(['NONE', 'T_MAIN', 'ALFA_MAIN', 'HEL_MAIN', 'BYBIT_USDT']);
  });

  it('offers category/subcategory pairs', () => {
    expect(props.category?.enum).toContain('Food / Cafes & coffee');
    expect(props.category?.enum).toContain('Misc');
    expect(props.category?.enum).not.toContain('Food');
  });
});

describe('categoryPairs', () => {
  it('maps pair keys back to category and subcategory', () => {
    expect(categoryPairs(ref).get('Transfer / Exchange')).toEqual({
      category: 'Transfer',
      subcategory: 'Exchange',
    });
  });
});

describe('fromAiOperation', () => {
  it('turns sentinels into nulls and never invents an account', () => {
    const raw = aiResponseSchema.parse({
      operations: [
        {
          date: '2026-09-10',
          type: 'Расход',
          account: 'NONE',
          amount: 300,
          currency: 'rub',
          toAccount: 'NONE',
          received: 0,
          category: 'Food / Cafes & coffee',
          comment: ' кофе ',
          oneOff: false,
          manualRate: 0,
        },
      ],
      note: '',
    }).operations[0]!;

    expect(fromAiOperation(raw, ref, today)).toEqual({
      ...expense({ date: '2026-09-10', account: null }),
      mentionedCurrency: 'RUB',
    });
  });

  it('drops unknown or archived accounts and bad dates', () => {
    const [raw] = aiResponseSchema.parse({
      operations: [{ date: 'вчера', account: 'ARCHIVE', amount: -5, category: 'Nope' }],
    }).operations;
    const op = fromAiOperation(raw!, ref, today);
    expect(op.date).toBe(today);
    expect(op.account).toBeNull();
    expect(op.amount).toBeNull();
    expect(op.category).toBeNull();
  });

  it('round-trips through the AI representation', () => {
    const op = expense({ oneOff: true, manualRate: 86.5 });
    expect(fromAiOperation(toAiOperation(op), ref, today)).toEqual(op);
  });
});

describe('aiResponseSchema', () => {
  it('fills defaults when the fallback mode omits fields', () => {
    const parsed = aiResponseSchema.parse({ operations: [{ amount: 100 }] });
    expect(parsed.note).toBe('');
    expect(parsed.operations[0]).toMatchObject({ type: 'Расход', account: 'NONE', amount: 100 });
  });
});

describe('parseJsonContent', () => {
  it('strips code fences', () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('{"a":2}')).toEqual({ a: 2 });
  });
});

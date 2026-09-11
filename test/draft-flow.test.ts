import { describe, expect, it } from 'vitest';
import { applyAction, applyInput } from '../src/bot/draft-actions.js';
import type { Draft } from '../src/bot/drafts.js';
import { cardKeyboard, pickerKeyboard } from '../src/bot/keyboards.js';
import { blankOperation, validate } from '../src/domain/operation.js';
import type { Reference } from '../src/domain/reference.js';
import { expense, ref, TZ } from './fixtures.js';

function wizardDraft(): Draft {
  return {
    id: 'abcd1234',
    chatId: 1,
    op: blankOperation('2026-09-11'),
    view: { kind: 'pick', picker: 'date' },
    wizard: true,
    touchedAt: 0,
  };
}

function step(draft: Draft): string {
  const { view } = draft;
  if (view.kind === 'pick') return view.picker;
  if (view.kind === 'input') return view.field;
  return 'card';
}

const accountIndex = (id: string) =>
  ref.accounts.filter((a) => a.type !== 'Архив').findIndex((a) => a.id === id);

describe('wizard', () => {
  it('walks an expense through every step', () => {
    const draft = wizardDraft();
    const trail: string[] = [step(draft)];

    applyAction(draft, ref, 'date', '0', TZ);
    trail.push(step(draft));
    applyAction(draft, ref, 'type', '0', TZ);
    trail.push(step(draft));
    applyAction(draft, ref, 'acc', String(accountIndex('T_MAIN')), TZ);
    trail.push(step(draft));
    expect(applyInput(draft, ref, '1,5к', TZ)).toBeNull();
    trail.push(step(draft));
    applyAction(draft, ref, 'cat', '1', TZ);
    trail.push(step(draft));
    applyAction(draft, ref, 'sub', '1', TZ);
    trail.push(step(draft));
    applyAction(draft, ref, 'skip', undefined, TZ);
    trail.push(step(draft));

    expect(trail).toEqual(['date', 'type', 'acc', 'amount', 'cat', 'sub', 'comment', 'card']);
    expect(draft.wizard).toBe(false);
    expect(draft.op).toMatchObject({
      amount: 1500,
      category: 'Food',
      subcategory: 'Cafes & coffee',
    });
    expect(validate(draft.op, ref)).toEqual([]);
  });

  it('asks for the received amount only on cross-currency transfers', () => {
    const draft = wizardDraft();
    applyAction(draft, ref, 'date', '-1', TZ);
    applyAction(draft, ref, 'type', '2', TZ);
    applyAction(draft, ref, 'acc', String(accountIndex('T_MAIN')), TZ);
    expect(step(draft)).toBe('to');
    applyAction(draft, ref, 'to', String(accountIndex('BYBIT_USDT')), TZ);
    applyInput(draft, ref, '10000', TZ);
    expect(step(draft)).toBe('received');
    applyInput(draft, ref, '110', TZ);
    // Transfer category is set automatically, so the wizard jumps to its subcategories
    expect(step(draft)).toBe('sub');
    applyAction(draft, ref, 'sub', '1', TZ);
    applyInput(draft, ref, 'обмен', TZ);

    expect(step(draft)).toBe('card');
    expect(draft.op).toMatchObject({
      type: 'Перевод',
      account: 'T_MAIN',
      toAccount: 'BYBIT_USDT',
      amount: 10000,
      received: 110,
      category: 'Transfer',
      subcategory: 'Exchange',
      comment: 'обмен',
    });
    expect(validate(draft.op, ref)).toEqual([]);
  });

  it('skips the received step for same-currency transfers', () => {
    const draft = wizardDraft();
    applyAction(draft, ref, 'date', '0', TZ);
    applyAction(draft, ref, 'type', '2', TZ);
    applyAction(draft, ref, 'acc', String(accountIndex('T_MAIN')), TZ);
    applyAction(draft, ref, 'to', String(accountIndex('ALFA_MAIN')), TZ);
    applyInput(draft, ref, '5000', TZ);
    expect(step(draft)).toBe('sub');
  });
});

describe('card mode', () => {
  function cardDraft(): Draft {
    return { ...wizardDraft(), op: expense(), view: { kind: 'card' }, wizard: false };
  }

  it('goes from category to subcategory and back to the card', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'cat', undefined, TZ);
    expect(step(draft)).toBe('cat');
    applyAction(draft, ref, 'cat', '2', TZ);
    expect(step(draft)).toBe('sub');
    expect(draft.op.subcategory).toBeNull();
    applyAction(draft, ref, 'sub', '0', TZ);
    expect(step(draft)).toBe('card');
    expect(draft.op).toMatchObject({ category: 'Transport', subcategory: 'Taxi & rideshare' });
  });

  it('reports stale list indexes', () => {
    const draft = cardDraft();
    expect(applyAction(draft, ref, 'acc', '99', TZ)).not.toBeNull();
    expect(draft.op.account).toBe('T_MAIN');
  });

  it('rejects dates in the future or too far back', () => {
    const draft = cardDraft();
    expect(applyAction(draft, ref, 'date', '1', TZ)).not.toBeNull();
    expect(applyAction(draft, ref, 'date', '-30', TZ)).not.toBeNull();
  });

  it('validates typed input', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'date', 'in', TZ);
    expect(step(draft)).toBe('date');
    expect(applyInput(draft, ref, 'завтра?', TZ)).not.toBeNull();
    expect(applyInput(draft, ref, '01.09', TZ)).toBeNull();
    expect(draft.op.date).toBe('2026-09-01');
    expect(step(draft)).toBe('card');
  });

  it('toggles one-off', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'oneoff', undefined, TZ);
    expect(draft.op.oneOff).toBe(true);
  });
});

describe('keyboards', () => {
  it('keeps callback data within Telegram’s 64-byte limit', () => {
    const longRef: Reference = {
      accounts: ref.accounts,
      categories: [
        {
          name: 'Очень длинная категория на русском языке',
          subcategories: ['Очень длинная подкатегория на русском языке для проверки'],
        },
      ],
    };
    const draft: Draft = {
      ...wizardDraft(),
      op: expense({ category: longRef.categories[0]!.name, subcategory: null }),
    };

    const keyboards = [
      cardKeyboard(draft),
      ...(['acc', 'to', 'cat', 'sub', 'date', 'type'] as const).map((p) =>
        pickerKeyboard(draft, p, longRef),
      ),
    ];
    const data = keyboards.flatMap((kb) =>
      kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : '')),
    );

    expect(data.length).toBeGreaterThan(10);
    for (const value of data) expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
  });
});

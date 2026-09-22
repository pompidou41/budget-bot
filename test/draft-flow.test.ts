import type { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import { applyAction, applyInput, MAX_COMMENT_LENGTH } from '../src/bot/draft-actions.js';
import type { Draft } from '../src/bot/drafts.js';
import { cardKeyboard, inputKeyboard, pickerKeyboard } from '../src/bot/keyboards.js';
import { renderDraft } from '../src/bot/render.js';
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
      cardKeyboard(draft, ref),
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

describe('comment from the card', () => {
  function cardDraft(comment = ''): Draft {
    return {
      id: 'abcd1234',
      chatId: 1,
      op: expense({ comment }),
      view: { kind: 'card' },
      wizard: false,
      touchedAt: 0,
    };
  }

  function labels(keyboard: InlineKeyboard): string[] {
    return keyboard.inline_keyboard.flat().map((button) => button.text);
  }

  it('offers to add a comment, or to change the one already there', () => {
    expect(labels(cardKeyboard(cardDraft(), ref))).toContain('💬 Комментарий');
    expect(labels(cardKeyboard(cardDraft('кофе'), ref))).toContain('💬 Изменить комментарий');
  });

  it('opens the input and puts the typed text on the card', () => {
    const draft = cardDraft();
    expect(applyAction(draft, ref, 'comment', undefined, TZ)).toBeNull();
    expect(draft.view).toMatchObject({ kind: 'input', field: 'comment' });

    expect(applyInput(draft, ref, '  с Лизой  ', TZ)).toBeNull();
    expect(draft.op.comment).toBe('с Лизой');
    expect(draft.view).toEqual({ kind: 'card' });
    expect(draft.wizard).toBe(false);
  });

  it('keeps the existing comment when the owner backs out of editing it', () => {
    const draft = cardDraft('кофе');
    applyAction(draft, ref, 'comment', undefined, TZ);

    const buttons = labels(inputKeyboard(draft, 'comment'));
    // «Пропустить» would erase the comment; from the card only an explicit removal may do that
    expect(buttons).not.toContain('Пропустить');
    expect(buttons).toEqual(['🗑 Убрать комментарий', '← Назад']);

    applyAction(draft, ref, 'back', undefined, TZ);
    expect(draft.op.comment).toBe('кофе');
    expect(draft.view).toEqual({ kind: 'card' });
  });

  it('removes the comment only on the explicit button', () => {
    const draft = cardDraft('кофе');
    applyAction(draft, ref, 'comment', undefined, TZ);
    applyAction(draft, ref, 'skip', undefined, TZ);

    expect(draft.op.comment).toBe('');
    expect(draft.view).toEqual({ kind: 'card' });
  });

  it('offers no removal when there is nothing to remove', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'comment', undefined, TZ);
    expect(labels(inputKeyboard(draft, 'comment'))).toEqual(['← Назад']);
  });

  it('still lets the wizard skip the comment step', () => {
    const draft: Draft = { ...wizardDraft(), view: { kind: 'input', field: 'comment', since: 0 } };
    expect(labels(inputKeyboard(draft, 'comment'))).toEqual(['Пропустить', '❌ Отмена']);
  });

  it('rejects an empty or overly long comment and keeps waiting', () => {
    const draft = cardDraft('кофе');
    applyAction(draft, ref, 'comment', undefined, TZ);

    expect(applyInput(draft, ref, '   ', TZ)).toMatch(/пустой/);
    expect(applyInput(draft, ref, 'я'.repeat(MAX_COMMENT_LENGTH + 1), TZ)).toMatch(/длиннее/);
    expect(draft.op.comment).toBe('кофе');
    expect(draft.view).toMatchObject({ kind: 'input', field: 'comment' });
  });

  it('escapes the current comment inside the edit prompt', () => {
    const draft = cardDraft('<b>босс</b>');
    applyAction(draft, ref, 'comment', undefined, TZ);

    const { text } = renderDraft(draft, ref);
    expect(text).toContain('заменит «&lt;b&gt;босс&lt;/b&gt;»');
  });
});

describe('amount from the card', () => {
  function cardDraft(op = expense()): Draft {
    return { id: 'abcd1234', chatId: 1, op, view: { kind: 'card' }, wizard: false, touchedAt: 0 };
  }

  function labels(keyboard: InlineKeyboard): string[] {
    return keyboard.inline_keyboard.flat().map((button) => button.text);
  }

  it('offers the button next to the other card fields', () => {
    expect(labels(cardKeyboard(cardDraft(), ref))).toContain('💰 Сумма');
  });

  it('opens the input and puts the typed amount on the card', () => {
    const draft = cardDraft();
    expect(applyAction(draft, ref, 'amount', undefined, TZ)).toBeNull();
    expect(draft.view).toMatchObject({ kind: 'input', field: 'amount' });

    expect(applyInput(draft, ref, '1,5к', TZ)).toBeNull();
    expect(draft.op.amount).toBe(1500);
    expect(draft.view).toEqual({ kind: 'card' });
    expect(draft.wizard).toBe(false);
  });

  it('settles the currency question the AI raised', () => {
    // The prompt names the account currency, so a typed figure answers «сумма названа в EUR»
    const draft = cardDraft(expense({ amount: 100, mentionedCurrency: 'EUR' }));
    applyAction(draft, ref, 'amount', undefined, TZ);
    applyInput(draft, ref, '8500', TZ);

    expect(draft.op).toMatchObject({ amount: 8500, mentionedCurrency: null });
    expect(validate(draft.op, ref)).toEqual([]);
  });

  it('rejects a non-number and keeps waiting', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'amount', undefined, TZ);

    expect(applyInput(draft, ref, 'много', TZ)).toMatch(/Не понял сумму/);
    expect(draft.op.amount).toBe(300);
    expect(draft.view).toMatchObject({ kind: 'input', field: 'amount' });
  });

  it('backs out to the card without touching the amount', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'amount', undefined, TZ);
    expect(labels(inputKeyboard(draft, 'amount'))).toEqual(['← Назад']);

    applyAction(draft, ref, 'back', undefined, TZ);
    expect(draft.op.amount).toBe(300);
    expect(draft.view).toEqual({ kind: 'card' });
  });

  it('names the account currency in the prompt', () => {
    const draft = cardDraft();
    applyAction(draft, ref, 'amount', undefined, TZ);
    expect(renderDraft(draft, ref).text).toContain('Сумма в RUB');
  });
});

describe('exchange rate from the card', () => {
  const account = ref.accounts[0]!;
  const fx: Reference = {
    ...ref,
    accounts: [
      ...ref.accounts,
      // Balances give the bot a sense of which currency is dearer: 1 EUR ≈ $1.1, 1 GEL ≈ $0.37
      { ...account, id: 'CASH_EUR', currency: 'EUR', balance: 100, balanceUsd: 110 },
      { ...account, id: 'CASH_GEL', currency: 'GEL', balance: 1000, balanceUsd: 370 },
      { ...account, id: 'CASH_RUB', currency: 'RUB', balance: 9000, balanceUsd: 100 },
    ],
  };

  function exchangeDraft(from = 'CASH_EUR', to = 'CASH_GEL', amount = 100): Draft {
    const op = expense({
      type: 'Перевод',
      account: from,
      toAccount: to,
      amount,
      category: 'Transfer',
      subcategory: 'Exchange',
    });
    return { id: 'abcd1234', chatId: 1, op, view: { kind: 'card' }, wizard: false, touchedAt: 0 };
  }

  function labels(keyboard: InlineKeyboard): string[] {
    return keyboard.inline_keyboard.flat().map((button) => button.text);
  }

  it('offers rate and received only when the transfer changes currency', () => {
    expect(labels(cardKeyboard(exchangeDraft(), fx))).toEqual(
      expect.arrayContaining(['💱 Курс', '📥 Пришло']),
    );
    expect(labels(cardKeyboard(exchangeDraft('T_MAIN', 'ALFA_MAIN'), fx))).not.toContain('💱 Курс');
    expect(labels(cardKeyboard({ ...exchangeDraft(), op: expense() }, fx))).not.toContain(
      '💱 Курс',
    );
  });

  it('turns EUR → GEL at 3,1 into 310 GEL received', () => {
    const draft = exchangeDraft();
    expect(applyAction(draft, fx, 'rate', undefined, TZ)).toBeNull();
    expect(renderDraft(draft, fx).text).toContain('сколько GEL за 1 EUR');

    expect(applyInput(draft, fx, '3,1', TZ)).toBeNull();
    expect(draft.op.received).toBe(310);
    expect(draft.op.manualRate).toBeNull();
    expect(draft.view).toEqual({ kind: 'card' });
    expect(validate(draft.op, fx)).toEqual([]);
    expect(renderDraft(draft, fx).text).toContain('💱 1 EUR = 3,1 GEL');
  });

  it('quotes the dearer currency as the base, so RUB → EUR takes «95»', () => {
    const draft = exchangeDraft('CASH_RUB', 'CASH_EUR', 9500);
    applyAction(draft, fx, 'rate', undefined, TZ);
    expect(renderDraft(draft, fx).text).toContain('сколько RUB за 1 EUR');

    applyInput(draft, fx, '95', TZ);
    expect(draft.op.received).toBe(100);
  });

  it('lets the received amount be typed straight from the card', () => {
    const draft = exchangeDraft();
    applyAction(draft, fx, 'received', undefined, TZ);
    applyInput(draft, fx, '305', TZ);

    expect(draft.op.received).toBe(305);
    expect(renderDraft(draft, fx).text).toContain('💱 1 EUR = 3,05 GEL');
  });

  it('rejects a non-number and keeps waiting', () => {
    const draft = exchangeDraft();
    applyAction(draft, fx, 'rate', undefined, TZ);
    expect(applyInput(draft, fx, 'хороший', TZ)).toMatch(/Не понял курс/);
    expect(draft.view).toMatchObject({ kind: 'input', field: 'rate' });
  });
});

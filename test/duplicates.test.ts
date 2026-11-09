import { describe, expect, it } from 'vitest';
import { heldView, placeOperations } from '../src/bot/duplicates.js';
import type { Draft } from '../src/bot/drafts.js';
import { isoToSerial } from '../src/domain/dates.js';
import {
  compareMovements,
  describeMatch,
  findDuplicates,
  sheetMovements,
  type Existing,
  type Movement,
} from '../src/domain/duplicates.js';
import { expense, ref } from './fixtures.js';

function move(overrides: Partial<Movement> = {}): Movement {
  return {
    date: '2026-10-09',
    type: 'Расход',
    account: 'HEL_MAIN',
    amount: 10,
    toAccount: null,
    received: null,
    comment: 'Localrent',
    ...overrides,
  };
}

function transfer(overrides: Partial<Movement> = {}): Movement {
  return move({
    type: 'Перевод',
    account: 'T_MAIN',
    amount: 5000,
    toAccount: 'BYBIT_USDT',
    received: 55.8,
    comment: 'crypto',
    ...overrides,
  });
}

function row(n: number, op: Movement): Existing {
  return { op, source: { kind: 'row', row: n } };
}

describe('compareMovements', () => {
  it('same account, amount and day is an exact repeat', () => {
    expect(compareMovements(move(), move({ comment: 'Localrent аренда авто' }))).toBe('exact');
  });

  it('a day apart is possible — the bank posts a purchase a day later', () => {
    expect(compareMovements(move({ date: '2026-10-10' }), move())).toBe('possible');
  });

  it('two days apart on the same account is a new purchase (Spar 13,10 every other day)', () => {
    expect(compareMovements(move({ date: '2026-10-11' }), move())).toBeNull();
  });

  it('different account, amount or type is a different operation', () => {
    expect(compareMovements(move({ account: 'T_MAIN' }), move())).toBeNull();
    expect(compareMovements(move({ amount: 10.01 }), move())).toBeNull();
    expect(compareMovements(move({ type: 'Доход' }), move())).toBeNull();
  });

  it('an operation without an account is never matched', () => {
    expect(compareMovements(move({ account: null }), move({ account: null }))).toBeNull();
  });

  it('salary in and the same sum sent on is a chain, not a repeat', () => {
    const salary = move({ type: 'Доход', account: 'ALFA_MAIN', amount: 148768 });
    const sentOn = transfer({ account: 'ALFA_MAIN', toAccount: 'T_MAIN', amount: 148768 });
    expect(compareMovements(salary, sentOn)).toBeNull();
    expect(compareMovements(sentOn, salary)).toBeNull();
  });

  it('two USDT buys of the same rubles that landed differently are two buys', () => {
    expect(compareMovements(transfer({ received: 57.27 }), transfer())).toBeNull();
  });

  it('the same transfer recorded twice the same day is exact', () => {
    expect(compareMovements(transfer(), transfer({ comment: 'Покупка USDT' }))).toBe('exact');
  });

  it('income on the receiving account matches a transfer that lost a little on the way', () => {
    const recorded = transfer({ toAccount: 'HEL_MAIN', amount: 5959, received: 170.38 });
    const landed = move({ type: 'Доход', amount: 170, date: '2026-10-11' });
    expect(compareMovements(landed, recorded)).toBe('possible');
    expect(compareMovements(recorded, landed)).toBe('possible');
  });

  it('an expense from the sending account matches the transfer', () => {
    const sent = move({ account: 'T_MAIN', amount: 5000 });
    expect(compareMovements(sent, transfer({ date: '2026-10-12' }))).toBe('possible');
    expect(compareMovements(sent, transfer({ date: '2026-10-13' }))).toBeNull();
  });

  it('half a transfer seen from one bank matches the recorded whole', () => {
    const halfSeen = transfer({ account: null, received: 55.8, date: '2026-10-10' });
    expect(compareMovements(halfSeen, transfer())).toBe('possible');
  });

  it('transfers between different pairs of accounts do not match', () => {
    const toMain = transfer({ account: 'ALFA_MAIN', toAccount: 'T_MAIN', received: null });
    expect(compareMovements(transfer(), toMain)).toBeNull();
  });
});

describe('findDuplicates', () => {
  it('pairs one to one: two metro rides against one recorded leaves the second new', () => {
    const ride = move({ amount: 1, comment: 'metro' });
    const found = findDuplicates([ride, ride], [row(10, ride)]);
    expect(found.map((d) => d?.kind ?? null)).toEqual(['exact', null]);
  });

  it('prefers an exact pair over a closer-looking possible one', () => {
    const found = findDuplicates([move()], [row(5, move({ date: '2026-10-10' })), row(6, move())]);
    expect(found[0]).toMatchObject({ kind: 'exact', match: { source: { row: 6 } } });
  });

  it('picks the nearest possible match by date', () => {
    const found = findDuplicates(
      [transfer({ account: null })],
      [row(1, transfer({ date: '2026-10-06' })), row(2, transfer({ date: '2026-10-08' }))],
    );
    expect(found[0]?.match.source).toEqual({ kind: 'row', row: 2 });
  });
});

describe('sheetMovements', () => {
  it('reads rows with their 1-based numbers, skipping the header and blank rows', () => {
    const rows = [
      ['Дата', 'Тип'],
      [isoToSerial('2026-10-09'), 'Расход', 'HEL_MAIN', 10, '', '', 'Travel', '', 'Localrent'],
      [],
      ['', '', '', ''],
      ['2026-10-10', 'Перевод', 'T_MAIN', 5000, 'BYBIT_USDT', 55.8, 'Transfer'],
    ];
    expect(sheetMovements(rows)).toEqual([
      row(2, move()),
      row(5, transfer({ date: '2026-10-10', comment: '' })),
    ]);
  });
});

describe('placeOperations', () => {
  const draft = (id: string, op = expense()): Draft => ({
    id,
    chatId: 1,
    op,
    view: { kind: 'card' },
    wizard: false,
    touchedAt: 0,
  });

  it('holds an exact repeat of an open draft — the second screenshot of an album', () => {
    const [placed] = placeOperations([expense()], [], [draft('ab12')], ref);
    expect(placed).toMatchObject({
      held: true,
      duplicate: expect.stringContaining('черновик выше'),
    });
  });

  it('flags a possible repeat but does not hold it', () => {
    const recorded = [row(734, { ...expense(), date: '2026-09-10' })];
    const [placed] = placeOperations([expense()], recorded, [], ref);
    expect(placed?.held).toBe(false);
    expect(placed?.duplicate).toBe('строка 734: 10.09 · T_MAIN · 300 RUB · кофе');
  });

  it('lists held repeats with a release button each', () => {
    const held = [draft('aa11'), draft('bb22', expense({ comment: '<script>' }))];
    held[0]!.duplicate = describeMatch(row(687, expense()), ref);
    const { text, keyboard } = heldView(held, ref);
    expect(text).toContain('1. 11.09 · T_MAIN · 300 RUB · кофе\n    → строка 687');
    expect(text).toContain('&lt;script&gt;');
    expect(
      keyboard.inline_keyboard.flat().map((b) => 'callback_data' in b && b.callback_data),
    ).toEqual(['h:aa11', 'h:bb22']);
  });
});

describe('transfers seen from one bank', () => {
  it('money landed from rubles the statement never saw matches the recorded transfer', () => {
    const recorded = transfer({ toAccount: 'HEL_MAIN', amount: 40400, received: 1140.84 });
    const fromStatement = transfer({ toAccount: 'HEL_MAIN', amount: null, received: 1140.84 });
    expect(compareMovements(fromStatement, recorded)).toBe('exact');
    expect(compareMovements({ ...fromStatement, date: '2026-10-10' }, recorded)).toBe('possible');
  });

  it('a conversion without the landed amount matches the recorded one', () => {
    const recorded = transfer({
      account: 'HEL_MAIN',
      toAccount: 'T_MAIN',
      amount: 1849.55,
      received: 710,
    });
    const fromStatement = { ...recorded, received: null };
    expect(compareMovements(fromStatement, recorded)).toBe('exact');
  });

  it('a landed amount that only roughly agrees is never exact', () => {
    const recorded = transfer({ toAccount: 'HEL_MAIN', amount: 5959, received: 170.38 });
    const fromStatement = transfer({ toAccount: 'HEL_MAIN', amount: null, received: 170 });
    expect(compareMovements(fromStatement, recorded)).toBe('possible');
  });

  it('nothing known but the accounts is not enough', () => {
    const a = transfer({ amount: null, received: null });
    expect(compareMovements(a, transfer({ account: null }))).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/bot/deps.js';
import { isoToSerial } from '../src/domain/dates.js';
import type { CellValue } from '../src/domain/operation.js';
import type { JournalEntry } from '../src/state/journal.js';
import { deps, press, testBot, type Call } from './statement-bot.js';

const values: CellValue[] = [
  '2026-10-09',
  'Расход',
  'CREDO_GEL',
  27.06,
  '',
  '',
  'Food',
  'Groceries',
  'Spar',
  false,
  '',
  46300.5,
];
const entry: JournalEntry = {
  row: 2,
  values,
  op: {
    date: '2026-10-09',
    type: 'Расход',
    account: 'CREDO_GEL',
    amount: 27.06,
    toAccount: null,
    received: null,
    category: 'Food',
    subcategory: 'Groceries',
    comment: 'Spar',
    oneOff: false,
    manualRate: null,
    mentionedCurrency: null,
  },
  savedAt: '2026-10-09T10:00:00.000Z',
};
const key = Date.parse(entry.savedAt);

function setup(over: Record<string, unknown> = {}) {
  const base = deps();
  const sheet = [['Дата'], [isoToSerial('2026-10-09'), ...values.slice(1)]];
  const appDeps = {
    ...base,
    journal: {
      last: () => entry,
      find: () => entry,
      remove: vi.fn(),
      add: vi.fn(),
      findByMessage: () => undefined,
    },
    repo: { ...base.repo, readRows: async () => sheet, ...over },
  } as unknown as AppDeps;
  return { appDeps, ...testBot(appDeps) };
}

const sent = (calls: Call[]) => calls.filter((c) => c.method === 'sendMessage').at(-1)!;

const edits = (calls: Call[]) => calls.filter((c) => c.method === 'editMessageText');

describe('undo deletes in one tap, in the same card', () => {
  it('↩️ on a saved card removes the row and turns that card into a draft', async () => {
    const { appDeps, bot, calls } = setup();
    await bot.handleUpdate(press(`u:${key}`, 50));
    expect(appDeps.repo.remove).toHaveBeenCalledWith([{ row: 2, values }]);
    // The bug: a second copy of the card used to be sent; now nothing new is sent
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    const edit = edits(calls).at(-1)!;
    expect(edit.payload.message_id).toBe(50);
    expect(String(edit.payload.text)).toContain('Удалено из таблицы · строка 2');
    expect(JSON.stringify(edit.payload.reply_markup)).toContain('Сохранить');
  });

  it('keeps the card and says so when the row is not in the sheet as written', async () => {
    const remove = vi.fn(async () => ({
      removed: [],
      notFound: [{ row: 2, values }],
      stillPresent: [],
      collateral: [],
    }));
    const { bot, calls } = setup({ remove });
    await bot.handleUpdate(press(`u:${key}`, 50));
    expect(edits(calls)).toHaveLength(0);
    expect(String(sent(calls).payload.text)).toContain('Не нашёл эту запись');
  });

  it('warns in plain words when a re-sort made the delete hit another row', async () => {
    const remove = vi.fn(async () => ({
      removed: [],
      notFound: [],
      stillPresent: [{ row: 2, values }],
      collateral: [{ cells: values, restoredTo: 5 }],
    }));
    const { bot, calls } = setup({ remove });
    await bot.handleUpdate(press(`u:${key}`, 50));
    expect(edits(calls)).toHaveLength(0);
    expect(String(sent(calls).payload.text)).toContain('таблицу пересортировали');
    expect(String(sent(calls).payload.text)).toContain('Нужная строка не удалена');
  });

  it('an old confirmation button u:y:<key> deletes the same way', async () => {
    const { appDeps, bot } = setup();
    await bot.handleUpdate(press(`u:y:${key}`, 50));
    expect(appDeps.repo.remove).toHaveBeenCalledWith([{ row: 2, values }]);
  });
});

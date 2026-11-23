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

describe('undo needs a confirmation', () => {
  it('an old u:<key> button only asks, showing the live row', async () => {
    const { appDeps, bot, calls } = setup();
    await bot.handleUpdate(press(`u:${key}`, 50));
    expect(appDeps.repo.remove).not.toHaveBeenCalled();
    expect(String(sent(calls).payload.text)).toContain('Удалить из таблицы строку 2');
    expect(JSON.stringify(sent(calls).payload.reply_markup)).toContain(`u:y:${key}`);
  });

  it('says so and deletes nothing when the row is not in the sheet as written', async () => {
    const { appDeps, bot, calls } = setup({ readRows: async () => [['Дата'], []] });
    await bot.handleUpdate(press(`u:${key}`, 50));
    expect(appDeps.repo.remove).not.toHaveBeenCalled();
    expect(String(sent(calls).payload.text)).toContain('уже нет');
  });

  it('warns in plain words when a re-sort made the delete hit another row', async () => {
    const remove = vi.fn(async () => ({
      removed: [],
      notFound: [],
      stillPresent: [{ row: 2, values }],
      collateral: [{ cells: values, restoredTo: 5 }],
    }));
    const { bot, calls } = setup({ remove });
    await bot.handleUpdate(press(`u:y:${key}`, 50));
    const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(String(edit.payload.text)).toContain('таблицу пересортировали');
    expect(String(edit.payload.text)).toContain('Нужная строка не удалена');
  });

  it('a confirmed delete shows what was deleted and returns an editable draft', async () => {
    const { appDeps, bot, calls } = setup();
    await bot.handleUpdate(press(`u:y:${key}`, 50));
    expect(appDeps.repo.remove).toHaveBeenCalledWith([{ row: 2, values }]);
    const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(String(edit.payload.text)).toContain('Удалено из таблицы · строка 2');
    expect(JSON.stringify(edit.payload.reply_markup)).toContain('Сохранить');
  });
});

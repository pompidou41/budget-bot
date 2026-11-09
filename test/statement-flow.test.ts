import type { Bot } from 'grammy';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/bot/deps.js';
import { createDraftStore } from '../src/bot/drafts.js';
import { createBot } from '../src/bot/index.js';
import { isoToSerial } from '../src/domain/dates.js';
import type { Reference } from '../src/domain/reference.js';
import { DEFAULT_SETTINGS } from '../src/domain/settings.js';
import { createConversations } from '../src/state/conversations.js';
import { createImportStore } from '../src/state/imports.js';
import type { RowGuess } from '../src/statement/plan.js';
import { ref as baseRef } from './fixtures.js';

const OWNER = 42;
const FIXTURE = readFileSync(new URL('./fixtures/credo-statement.xlsx', import.meta.url));

const ref: Reference = {
  ...baseRef,
  accounts: [
    ...baseRef.accounts,
    {
      id: 'CREDO_GEL',
      name: 'Дебетовая карта Credo Bank',
      bank: 'Credo Bank',
      type: 'Карта',
      currency: 'GEL',
      group: 'Текущие',
      inCapital: true,
      balance: 1000,
      balanceUsd: null,
    },
  ],
};

const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), 'budget-bot-')), name);

// The fixture's row 9: «spar 27.06 GEL 09.10.2026», already in the sheet
const SHEET = [
  ['Дата', 'Тип'],
  [isoToSerial('2026-10-09'), 'Расход', 'CREDO_GEL', 27.06, '', '', 'Food', 'Groceries', 'Spar'],
];

function deps() {
  const guess: RowGuess = {
    type: 'Расход',
    counterAccount: null,
    category: 'Food',
    subcategory: 'Groceries',
    comment: 'покупка',
    sure: true,
  };
  return {
    env: {
      BOT_TOKEN: '1:x',
      OWNER_TELEGRAM_ID: OWNER,
      BOT_TIMEZONE: 'Europe/Moscow',
      RENDER_MODE: 'html',
    } as AppDeps['env'],
    refs: { get: async () => ref, reload: async () => ref } as unknown as AppDeps['refs'],
    data: { get: async () => [], reload: async () => [] } as unknown as AppDeps['data'],
    repo: {
      readRows: vi.fn(async () => SHEET),
      appendMany: vi.fn(async (rows: unknown[][]) =>
        rows.map((values, i) => ({ row: 100 + i, values })),
      ),
      clearMany: vi.fn(async (rows: unknown[]) => rows.length),
    } as unknown as AppDeps['repo'],
    journal: { findByMessage: () => undefined } as unknown as AppDeps['journal'],
    settings: { get: () => DEFAULT_SETTINGS } as unknown as AppDeps['settings'],
    parser: {} as AppDeps['parser'],
    analyst: {} as AppDeps['analyst'],
    transcribe: vi.fn() as unknown as AppDeps['transcribe'],
    drafts: createDraftStore(tmp('drafts.json')),
    conversations: createConversations(tmp('conversations.json')),
    statements: {
      classifier: {
        classify: vi.fn(
          async (rows: { index: number }[]) => new Map(rows.map((r) => [r.index, guess])),
        ),
      },
      extractor: { extract: vi.fn() },
      imports: createImportStore(tmp('imports.json')),
    } as unknown as AppDeps['statements'],
    health: { headerProblems: [] },
    checkHeader: async () => [],
  } satisfies AppDeps;
}

type Call = { method: string; payload: Record<string, unknown> };

/** Buttons and message of the latest summary the bot drew. */
function lastSummary(calls: Call[]): { data: string[]; messageId: number } {
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
  const markup = edit.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  return {
    data: markup.inline_keyboard.flat().map((b) => b.callback_data),
    messageId: edit.payload.message_id as number,
  };
}

function testBot(appDeps: AppDeps) {
  const calls: Call[] = [];
  const bot = createBot(appDeps);
  bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b' } as Bot['botInfo'];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === 'getFile'
        ? { file_id: 'f', file_unique_id: 'u', file_path: 'documents/f.xlsx' }
        : { message_id: 900 + calls.length, chat: { id: OWNER }, date: 0 };
    return Promise.resolve({ ok: true, result } as never);
  });
  const texts = () =>
    calls
      .filter((c) => c.method === 'editMessageText')
      .map((c) => String(c.payload.text))
      .filter((t) => t.includes('Выписка'));
  return { bot, calls, texts };
}

const message = { message_id: 10, date: 0, chat: { id: OWNER, type: 'private' as const } };
const from = { id: OWNER, is_bot: false, first_name: 'o' };

function documentUpdate() {
  return {
    update_id: 1,
    message: {
      ...message,
      from,
      document: {
        file_id: 'f',
        file_unique_id: 'u',
        file_name: 'MYCREDO-GEL-STATEMENT.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_size: FIXTURE.length,
      },
    },
  };
}

function press(data: string, messageId: number) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    callback_query: {
      id: 'q',
      from,
      chat_instance: 'c',
      data,
      message: { ...message, message_id: messageId, from, text: '…' },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('statement import', () => {
  it('reads the file, skips what is recorded, writes the rest and undoes it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(FIXTURE));
    const appDeps = deps();
    const { bot, calls, texts } = testBot(appDeps);

    await bot.handleUpdate(documentUpdate());
    await vi.waitFor(() => expect(texts().at(-1)).toContain('готовы к записи'));

    const summary = texts().at(-1)!;
    expect(summary).toContain('CREDO_GEL · 08.10 – 12.10');
    expect(summary).toContain('12 операций');
    expect(summary).toContain('⏭ 1 уже в таблице');
    expect(summary).toContain('🆕 11 готовы к записи');
    const classify = vi.mocked(appDeps.statements.classifier.classify);
    expect(classify.mock.calls[0]?.[1]).toMatchObject({
      account: 'CREDO_GEL',
      holder: 'ტესტ მფლობელი',
    });

    const { data, messageId } = lastSummary(calls);
    expect(data).toEqual([
      expect.stringMatching(/^i:[0-9a-f]+:w$/),
      expect.any(String),
      expect.any(String),
    ]);
    const id = data[0]!.split(':')[1]!;
    await bot.handleUpdate(press(`i:${id}:w`, messageId));

    const written = vi.mocked(appDeps.repo.appendMany).mock.calls[0]?.[0] ?? [];
    expect(written).toHaveLength(11);
    // Sorted by the date of the operation, not by booking
    expect(written.map((row) => row[0])).toEqual([...written.map((row) => row[0])].sort());
    expect(written.find((row) => row[3] === 1140.84)?.[1]).toBe('Доход');
    expect(texts().at(-1)).toContain('✅ Записано 11 · строки 100–110');

    await bot.handleUpdate(press(`i:${id}:u`, messageId));
    expect(appDeps.repo.clearMany).toHaveBeenCalledOnce();
    expect(texts().at(-1)).toContain('Импорт отменён');

    // A stale button after the undo does nothing
    await bot.handleUpdate(press(`i:${id}:w`, messageId));
    expect(appDeps.repo.appendMany).toHaveBeenCalledOnce();
    expect(calls.at(-1)?.payload.text).toBe('Эта кнопка уже неактуальна');
  });

  it('passes other documents on to the input handlers', async () => {
    const appDeps = deps();
    const { bot, calls } = testBot(appDeps);
    const update = documentUpdate();
    update.message.document.file_name = 'notes.txt';
    update.message.document.mime_type = 'text/plain';

    await bot.handleUpdate(update);

    expect(calls.map((c) => c.payload.text)).toEqual([
      'Понимаю текст, голосовые, картинки и выписки PDF или XLSX.',
    ]);
  });
});

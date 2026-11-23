import type { Bot } from 'grammy';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
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

/** A bot over fakes of the sheet and the model, fed the Credo XLSX fixture. */
export const OWNER = 42;
export const FIXTURE = readFileSync(new URL('./fixtures/credo-statement.xlsx', import.meta.url));

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

export function deps() {
  // The fake sheet: what the bot writes is read back, and removed rows disappear
  const sheet: unknown[][] = [...SHEET];
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
      readRows: vi.fn(async () => sheet.map((r) => r ?? [])),
      appendMany: vi.fn(async (rows: unknown[][]) =>
        rows.map((values, i) => {
          sheet[99 + i] = values;
          return { row: 100 + i, values };
        }),
      ),
      remove: vi.fn(async (rows: { row: number; values: unknown[] }[]) => {
        for (const r of rows) sheet[r.row - 1] = [];
        return { removed: rows, notFound: [], stillPresent: [], collateral: [] };
      }),
      append: vi.fn(async () => ({ row: 200, usd: null })),
    } as unknown as AppDeps['repo'],
    journal: { findByMessage: () => undefined, add: vi.fn() } as unknown as AppDeps['journal'],
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
    workbook: { get: async () => ({ title: '', tabs: [] }) },
  } satisfies AppDeps;
}

export type Call = { method: string; payload: Record<string, unknown> };

/** Buttons and message of the latest summary the bot drew. */
export function lastSummary(calls: Call[]): { data: string[]; messageId: number } {
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
  const markup = edit.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  return {
    data: markup.inline_keyboard.flat().map((b) => b.callback_data),
    messageId: edit.payload.message_id as number,
  };
}

export function testBot(appDeps: AppDeps) {
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

export function documentUpdate() {
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

export function press(data: string, messageId: number) {
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

export function replyUpdate(text: string, replyTo: number) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      ...message,
      message_id: 500 + Math.floor(Math.random() * 1e4),
      from,
      text,
      reply_to_message: { ...message, message_id: replyTo, from, text: '…' },
    },
  };
}

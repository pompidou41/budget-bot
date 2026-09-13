import type { Bot } from 'grammy';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/bot/deps.js';
import { createDraftStore } from '../src/bot/drafts.js';
import { createBot } from '../src/bot/index.js';
import { createConversations } from '../src/state/conversations.js';
import type { Answer } from '../src/domain/answer.js';
import { DEFAULT_SETTINGS } from '../src/domain/settings.js';
import { ref } from './fixtures.js';

const OWNER = 42;
const CHAT = 42;

function tmp(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), name);
}

const TXN = {
  date: '2026-09-11',
  month: '2026-09',
  type: 'Расход' as const,
  account: 'T_MAIN',
  toAccount: '',
  amount: 10,
  currency: 'USD',
  usd: 10,
  category: 'Food',
  subcategory: '',
  comment: '',
  oneOff: false,
};

const ANSWER: Answer = {
  headline: 'Ответ аналитика',
  sections: [],
  seriesTitle: '',
  seriesUnit: '',
  series: [],
  note: '',
};

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: {
      BOT_TOKEN: '1:x',
      OWNER_TELEGRAM_ID: OWNER,
      BOT_TIMEZONE: 'Europe/Moscow',
      RENDER_MODE: 'html',
    } as AppDeps['env'],
    refs: { get: async () => ref, reload: async () => ref } as unknown as AppDeps['refs'],
    // /ask bails out early on an empty sheet, so the history must not be empty here
    data: { get: async () => [TXN], reload: async () => [TXN] } as unknown as AppDeps['data'],
    repo: {} as AppDeps['repo'],
    journal: { findByMessage: () => undefined } as unknown as AppDeps['journal'],
    settings: { get: () => DEFAULT_SETTINGS } as unknown as AppDeps['settings'],
    parser: {
      parse: vi.fn(async () => ({ operations: [], note: null })),
      edit: vi.fn(async () => ({ operations: [], note: null })),
    } as unknown as AppDeps['parser'],
    analyst: { ask: vi.fn(async () => ANSWER) } as unknown as AppDeps['analyst'],
    transcribe: vi.fn(async () => 'а по неделям?') as unknown as AppDeps['transcribe'],
    drafts: createDraftStore(tmp('drafts.json')),
    conversations: createConversations(tmp('conversations.json')),
    health: { headerProblems: [] },
    checkHeader: async () => [],
    ...overrides,
  };
}

/** A bot whose every API call is recorded instead of sent. */
function testBot(appDeps: AppDeps) {
  const calls: { method: string; payload: unknown }[] = [];
  const bot = createBot(appDeps);
  bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b' } as Bot['botInfo'];

  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    const result =
      method === 'getFile'
        ? { file_id: 'f', file_unique_id: 'u', file_path: 'voice/f.oga' }
        : { message_id: 900 + calls.length, chat: { id: CHAT }, date: 0 };
    return Promise.resolve({ ok: true, result } as never);
  });

  return { bot, calls };
}

function textUpdate(text: string, replyToId?: number) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 10,
      date: 0,
      chat: { id: CHAT, type: 'private' as const },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text,
      ...(replyToId === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: replyToId,
              date: 0,
              chat: { id: CHAT, type: 'private' as const },
            },
          }),
    },
  };
}

describe('reply routing', () => {
  it('sends a reply to a known answer to the analyst, not to the parser', async () => {
    const appDeps = deps();
    appDeps.conversations.remember(CHAT, 500, []);
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(textUpdate('а по неделям?', 500));

    expect(appDeps.analyst.ask).toHaveBeenCalledOnce();
    expect(appDeps.parser.parse).not.toHaveBeenCalled();
  });

  it('still routes to the analyst after a restart drops the history', async () => {
    const path = tmp('conversations.json');
    createConversations(path).remember(CHAT, 500, []);

    // A fresh store is what the process gets after `pm2 reload`
    const appDeps = deps({ conversations: createConversations(path) });
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(textUpdate('а по неделям?', 500));

    expect(appDeps.analyst.ask).toHaveBeenCalledOnce();
    expect(appDeps.parser.parse).not.toHaveBeenCalled();
  });

  it('treats a message that is not a reply as a new operation', async () => {
    const appDeps = deps();
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(textUpdate('кофе 300 с тинька'));

    expect(appDeps.parser.parse).toHaveBeenCalledOnce();
    expect(appDeps.analyst.ask).not.toHaveBeenCalled();
  });

  it('routes a spoken reply to the analyst too', async () => {
    // downloadTelegramFile goes straight to api.telegram.org, outside the API transformer
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ArrayBuffer(8)));
    const appDeps = deps();
    appDeps.conversations.remember(CHAT, 500, []);
    const { bot } = testBot(appDeps);

    const update = textUpdate('', 500) as Record<string, never>;
    const message = update.message as unknown as Record<string, unknown>;
    delete message.text;
    message.voice = { file_id: 'f', file_unique_id: 'u', duration: 5 };

    await bot.handleUpdate(update as never);

    expect(appDeps.transcribe).toHaveBeenCalledOnce();
    expect(appDeps.analyst.ask).toHaveBeenCalledOnce();
    expect(appDeps.parser.parse).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

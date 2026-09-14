import type { Bot } from 'grammy';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/bot/deps.js';
import { createDraftStore } from '../src/bot/drafts.js';
import { createBot } from '../src/bot/index.js';
import { createConversations } from '../src/state/conversations.js';
import { createSettingsStore } from '../src/state/settings.js';
import { todayIn } from '../src/domain/dates.js';
import type { Review } from '../src/domain/review.js';
import type { Answer } from '../src/domain/answer.js';
import { DEFAULT_SETTINGS } from '../src/domain/settings.js';
import { expense as expenseOp, ref } from './fixtures.js';

const OWNER = 42;
const CHAT = 42;

function tmp(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), name);
}

// Dated today, so every review scope that includes the current month has something to look at
const TODAY = todayIn('Europe/Moscow');

const TXN = {
  date: TODAY,
  month: TODAY.slice(0, 7),
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

const REVIEW: Review = {
  headline: 'Разбор',
  story: 'История',
  insights: [],
  actions: [],
  explain: '',
  followUp: '',
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
    analyst: {
      ask: vi.fn(async () => ANSWER),
      review: vi.fn(async () => REVIEW),
    } as unknown as AppDeps['analyst'],
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

    await vi.waitFor(() => expect(appDeps.analyst.ask).toHaveBeenCalledOnce());
    expect(appDeps.parser.parse).not.toHaveBeenCalled();
  });

  it('still routes to the analyst after a restart drops the history', async () => {
    const path = tmp('conversations.json');
    createConversations(path).remember(CHAT, 500, []);

    // A fresh store is what the process gets after `pm2 reload`
    const appDeps = deps({ conversations: createConversations(path) });
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(textUpdate('а по неделям?', 500));

    await vi.waitFor(() => expect(appDeps.analyst.ask).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(appDeps.analyst.ask).toHaveBeenCalledOnce());
    expect(appDeps.parser.parse).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('/review', () => {
  function commandUpdate(text: string) {
    const command = text.split(' ')[0] ?? text;
    return {
      update_id: Math.floor(Math.random() * 1e6),
      message: {
        message_id: 11,
        date: 0,
        chat: { id: CHAT, type: 'private' as const },
        from: { id: OWNER, is_bot: false, first_name: 'o' },
        text,
        entities: [{ type: 'bot_command' as const, offset: 0, length: command.length }],
      },
    };
  }

  it('reviews the period named in the command and anchors the reply thread on it', async () => {
    const appDeps = deps();
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(commandUpdate('/review этот месяц'));

    await vi.waitFor(() => expect(appDeps.analyst.review).toHaveBeenCalledOnce());
    const input = vi.mocked(appDeps.analyst.review).mock.calls[0]?.[0];
    expect(input?.signals.window.scope).toBe('mtd');

    // The review message becomes an /ask anchor, so a reply to it is a follow-up question
    await vi.waitFor(() => expect(appDeps.conversations.knows(CHAT, 902)).toBe(true));
  });

  it('does not hold the update queue while the model thinks', async () => {
    let release: () => void = () => undefined;
    const appDeps = deps({
      analyst: {
        ask: vi.fn(async () => ANSWER),
        review: vi.fn(() => new Promise<Review>((resolve) => (release = () => resolve(REVIEW)))),
      } as unknown as AppDeps['analyst'],
    });
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(commandUpdate('/review этот месяц'));
    // The review is still thinking, yet an expense typed meanwhile goes straight through
    await bot.handleUpdate(textUpdate('кофе 300 с тинька'));

    expect(appDeps.parser.parse).toHaveBeenCalledOnce();
    release();
  });
});

describe('voice is just another way to type', () => {
  function voiceUpdate() {
    return {
      update_id: Math.floor(Math.random() * 1e6),
      message: {
        message_id: 20,
        date: 0,
        chat: { id: CHAT, type: 'private' as const },
        from: { id: OWNER, is_bot: false, first_name: 'o' },
        voice: { file_id: 'f', file_unique_id: 'u', duration: 5 },
      },
    };
  }

  function spoken(transcript: string): Partial<AppDeps> {
    return { transcribe: vi.fn(async () => transcript) as unknown as AppDeps['transcribe'] };
  }

  // downloadTelegramFile goes straight to api.telegram.org, outside the API transformer
  function mockDownload() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ArrayBuffer(8)));
  }

  it('fills a comment the card is waiting for, instead of starting a new operation', async () => {
    mockDownload();
    const appDeps = deps(spoken('с Лизой'));
    const draft = appDeps.drafts.create(CHAT, expenseOp(), {
      messageId: 700,
      view: { kind: 'input', field: 'comment', since: Date.now() },
    });
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(voiceUpdate());

    expect(appDeps.parser.parse).not.toHaveBeenCalled();
    expect(draft.op.comment).toBe('с Лизой');
    expect(draft.view).toEqual({ kind: 'card' });
    vi.restoreAllMocks();
  });

  it('still starts a new operation when nothing is waiting', async () => {
    mockDownload();
    const appDeps = deps(spoken('кофе 300 с тинька'));
    const { bot } = testBot(appDeps);

    await bot.handleUpdate(voiceUpdate());

    expect(appDeps.parser.parse).toHaveBeenCalledOnce();
    expect(vi.mocked(appDeps.parser.parse).mock.calls[0]?.[0]).toMatchObject({
      text: 'кофе 300 с тинька',
    });
    vi.restoreAllMocks();
  });

  it('adds a note for the AI when the settings screen is waiting for one', async () => {
    mockDownload();
    const appDeps = deps({
      ...spoken('Елизавета С. — моя девушка Лиза'),
      settings: createSettingsStore(tmp('settings.json')),
    });
    const { bot } = testBot(appDeps);

    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'q',
        from: { id: OWNER, is_bot: false, first_name: 'o' },
        chat_instance: 'c',
        data: 's:al:add',
        message: { message_id: 800, date: 0, chat: { id: CHAT, type: 'private' as const } },
      },
    } as never);
    await bot.handleUpdate(voiceUpdate());

    expect(appDeps.settings.get().notes.map((n) => n.text)).toEqual([
      'Елизавета С. — моя девушка Лиза',
    ]);
    expect(appDeps.parser.parse).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

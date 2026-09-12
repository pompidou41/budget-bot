import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalystTurn } from '../src/ai/analyst.js';
import { createConversations } from '../src/state/conversations.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), 'conversations.json');
}

const turns: AnalystTurn[] = [
  { role: 'user', content: 'сколько на еду' },
  { role: 'assistant', content: '{"action":"answer"}' },
];

describe('conversations', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('recalls a thread by its anchor message', () => {
    const store = createConversations(storePath());
    store.remember(1, 100, turns);

    expect(store.recall(1, 100)).toEqual(turns);
    expect(store.knows(1, 100)).toBe(true);
  });

  it('does not confuse anchors from different chats', () => {
    const store = createConversations(storePath());
    store.remember(1, 100, turns);

    expect(store.recall(2, 100)).toBeUndefined();
    expect(store.knows(2, 100)).toBe(false);
  });

  it('survives a restart, which is the whole point of the file', () => {
    const path = storePath();
    createConversations(path).remember(1, 100, turns);

    expect(createConversations(path).recall(1, 100)).toEqual(turns);
  });

  it('keeps the anchor after the history expires, so a reply is still a question', () => {
    const store = createConversations(storePath());
    store.remember(1, 100, turns);

    vi.advanceTimersByTime(DAY_MS + 1000);

    expect(store.recall(1, 100)).toBeUndefined();
    expect(store.knows(1, 100)).toBe(true);
  });

  it('re-anchoring the same message refreshes it instead of duplicating', () => {
    const store = createConversations(storePath());
    store.remember(1, 100, turns);

    vi.advanceTimersByTime(DAY_MS - 1000);
    store.remember(1, 100, [...turns, { role: 'user', content: 'а по неделям' }]);
    vi.advanceTimersByTime(2000);

    expect(store.recall(1, 100)).toHaveLength(3);
  });

  it('drops the oldest anchors once the limit is reached', () => {
    const store = createConversations(storePath(), 2);
    store.remember(1, 100, turns);
    store.remember(1, 101, turns);
    store.remember(1, 102, turns);

    expect(store.knows(1, 100)).toBe(false);
    expect(store.knows(1, 101)).toBe(true);
    expect(store.knows(1, 102)).toBe(true);
  });

  it('starts empty when the file is corrupt rather than refusing to boot', () => {
    const path = storePath();
    writeFileSync(path, '{ not json');

    const store = createConversations(path);
    expect(store.knows(1, 100)).toBe(false);
    store.remember(1, 100, turns);
    expect(store.recall(1, 100)).toEqual(turns);
  });
});

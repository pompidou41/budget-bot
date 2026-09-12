import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftStore } from '../src/bot/drafts.js';
import { expense } from './fixtures.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), 'drafts.json');
}

describe('draft store persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reloads a card after a restart, so a reply still edits it', () => {
    const path = storePath();
    const store = createDraftStore(path);
    store.create(1, expense(), { messageId: 500 });
    store.flush();

    const reloaded = createDraftStore(path);
    expect(reloaded.byMessage(1, 500)?.op.comment).toBe(expense().comment);
  });

  it('does not resurrect a card that expired while the bot was down', () => {
    const path = storePath();
    const store = createDraftStore(path);
    const draft = store.create(1, expense(), { messageId: 500 });
    store.flush();

    vi.advanceTimersByTime(DAY_MS + 1000);

    const reloaded = createDraftStore(path);
    expect(reloaded.get(draft.id)).toBeUndefined();
  });

  it('persists in-place edits made by handlers on the next flush', () => {
    const path = storePath();
    const store = createDraftStore(path);
    const draft = store.create(1, expense(), { messageId: 500 });
    draft.op = { ...draft.op, comment: 'исправлено' };
    store.flush();

    expect(createDraftStore(path).byMessage(1, 500)?.op.comment).toBe('исправлено');
  });

  it('forgets a deleted draft on the next flush', () => {
    const path = storePath();
    const store = createDraftStore(path);
    const draft = store.create(1, expense(), { messageId: 500 });
    store.flush();
    store.delete(draft.id);
    store.flush();

    expect(createDraftStore(path).byMessage(1, 500)).toBeUndefined();
  });
});

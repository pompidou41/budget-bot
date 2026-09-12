import { randomBytes } from 'crypto';
import type { Operation } from '../domain/operation.js';
import { readJson, writeJsonAtomic } from '../state/file.js';

export type Picker = 'acc' | 'to' | 'cat' | 'sub' | 'date' | 'type';
export type InputField = 'amount' | 'received' | 'comment' | 'date';
export type WizardStep = Picker | InputField;

export type DraftView =
  | { kind: 'card' }
  | { kind: 'pick'; picker: Picker }
  | { kind: 'input'; field: InputField; since: number };

/** Unsaved operation bound to one bot message (the card). */
export interface Draft {
  id: string;
  chatId: number;
  op: Operation;
  view: DraftView;
  /** Step-by-step /add mode: each answer advances to the next missing field. */
  wizard: boolean;
  messageId?: number;
  transcript?: string;
  note?: string;
  saving?: boolean;
  touchedAt: number;
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const INPUT_TTL_MS = 15 * 60 * 1000;

export interface DraftStore {
  create(
    chatId: number,
    op: Operation,
    init?: Partial<Pick<Draft, 'view' | 'wizard' | 'transcript' | 'note' | 'messageId'>>,
  ): Draft;
  get(id: string): Draft | undefined;
  byMessage(chatId: number, messageId: number): Draft | undefined;
  /** Most recent draft waiting for typed input (amount, comment…) in this chat. */
  awaitingInput(chatId: number): Draft | undefined;
  delete(id: string): void;
  /**
   * Writes the current drafts to disk. Handlers mutate `Draft` objects in place, so the bot
   * calls this once per update rather than making every field assignment go through the store.
   */
  flush(): void;
}

/**
 * Drafts survive a restart: `pm2 reload` on deploy used to drop them, and a reply meant to
 * correct a card then came back as a brand-new operation.
 */
export function createDraftStore(path = 'data/drafts.json'): DraftStore {
  const drafts = new Map<string, Draft>();
  const stored = readJson<Draft[]>(path, [], 'Drafts');
  for (const draft of Array.isArray(stored) ? stored : []) {
    // A draft that expired while the bot was down must not resurface as a live card
    if (Date.now() - draft.touchedAt <= DRAFT_TTL_MS) drafts.set(draft.id, draft);
  }

  function sweep(now: number): void {
    for (const [id, draft] of drafts) {
      if (now - draft.touchedAt > DRAFT_TTL_MS) drafts.delete(id);
    }
  }

  return {
    create(chatId, op, init = {}) {
      const now = Date.now();
      sweep(now);
      const draft: Draft = {
        id: randomBytes(4).toString('hex'),
        chatId,
        op,
        view: { kind: 'card' },
        wizard: false,
        touchedAt: now,
        ...init,
      };
      drafts.set(draft.id, draft);
      return draft;
    },

    get(id) {
      const draft = drafts.get(id);
      if (draft) draft.touchedAt = Date.now();
      return draft;
    },

    byMessage(chatId, messageId) {
      for (const draft of drafts.values()) {
        if (draft.chatId === chatId && draft.messageId === messageId) return draft;
      }
      return undefined;
    },

    awaitingInput(chatId) {
      const now = Date.now();
      let latest: { draft: Draft; since: number } | undefined;
      for (const draft of drafts.values()) {
        const { view } = draft;
        if (draft.chatId !== chatId || view.kind !== 'input') continue;
        if (now - view.since > INPUT_TTL_MS) continue;
        if (!latest || view.since > latest.since) latest = { draft, since: view.since };
      }
      return latest?.draft;
    },

    delete(id) {
      drafts.delete(id);
    },

    flush() {
      writeJsonAtomic(path, [...drafts.values()]);
    },
  };
}

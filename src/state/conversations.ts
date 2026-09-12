import type { AnalystTurn } from '../ai/analyst.js';
import { readJson, writeJsonAtomic } from './file.js';

/** One `/ask` thread, anchored to the bot message that holds its last answer. */
export interface ConversationEntry {
  chatId: number;
  /** The answer message a reply must point at to continue this thread. */
  messageId: number;
  turns: AnalystTurn[];
  touchedAt: number;
}

const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

export interface Conversations {
  /** Records an answer message as the new anchor of its thread. */
  remember(chatId: number, messageId: number, turns: AnalystTurn[]): void;
  /** History behind an anchor, or undefined once it has expired. */
  recall(chatId: number, messageId: number): AnalystTurn[] | undefined;
  /**
   * True when this message is an answer of ours, even if its history already expired.
   * A reply to a known anchor is always a question — never an operation to parse.
   */
  knows(chatId: number, messageId: number): boolean;
}

/**
 * Persisted so that a reply keeps working across a deploy: `pm2 reload` used to wipe the
 * in-memory threads, after which a follow-up question fell through to the catch-all input
 * handler and came back as a draft expense.
 */
export function createConversations(path = 'data/conversations.json', limit = 60): Conversations {
  let entries = readJson<ConversationEntry[]>(path, [], 'Conversation history');
  if (!Array.isArray(entries)) entries = [];

  function find(chatId: number, messageId: number): ConversationEntry | undefined {
    return entries.find((e) => e.chatId === chatId && e.messageId === messageId);
  }

  return {
    remember(chatId, messageId, turns) {
      const entry: ConversationEntry = { chatId, messageId, turns, touchedAt: Date.now() };
      entries = [
        ...entries.filter((e) => !(e.chatId === chatId && e.messageId === messageId)),
        entry,
      ]
        // Anchors outlive their history: the oldest ones only drop out on overflow, so a reply
        // to a stale answer still starts a fresh question instead of a draft expense.
        .slice(-limit);
      writeJsonAtomic(path, entries);
    },

    recall(chatId, messageId) {
      const entry = find(chatId, messageId);
      if (!entry) return undefined;
      return Date.now() - entry.touchedAt > HISTORY_TTL_MS ? undefined : entry.turns;
    },

    knows: (chatId, messageId) => find(chatId, messageId) !== undefined,
  };
}

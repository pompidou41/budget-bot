import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { CellValue, Operation } from '../domain/operation.js';
import { logger } from '../logger.js';

/** A row the bot wrote to «Операции»; used to undo exactly that row. */
export interface JournalEntry {
  row: number;
  values: CellValue[];
  op: Operation;
  savedAt: string;
  messageId?: number;
}

export interface Journal {
  add(entry: JournalEntry): void;
  last(): JournalEntry | undefined;
  /** By `entryKey` (callbacks carry it); a bare row number still finds the newest entry for it. */
  find(key: number): JournalEntry | undefined;
  findByMessage(messageId: number): JournalEntry | undefined;
  remove(key: number): void;
}

/** Stable id of an entry: its save time. The row number goes stale once the sheet is re-sorted. */
export function entryKey(entry: Pick<JournalEntry, 'savedAt'>): number {
  return Date.parse(entry.savedAt);
}

/** Row numbers are far below any timestamp, so the two kinds of key never collide. */
const MAX_ROW = 1e7;

function matches(entry: JournalEntry, key: number): boolean {
  return key < MAX_ROW ? entry.row === key : entryKey(entry) === key;
}

export function createJournal(path = 'data/journal.json', limit = 50): Journal {
  let entries = load();

  function load(): JournalEntry[] {
    if (!existsSync(path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
    } catch (error) {
      logger.warn({ error, path }, 'Journal is unreadable, starting empty');
      return [];
    }
  }

  function persist(): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2));
    renameSync(tmp, path);
  }

  return {
    add(entry) {
      entries = [...entries, entry].slice(-limit);
      persist();
    },
    last: () => entries.at(-1),
    find: (key) => entries.findLast((e) => matches(e, key)),
    findByMessage: (messageId) => entries.find((e) => e.messageId === messageId),
    remove(key) {
      const found = entries.findLast((e) => matches(e, key));
      entries = entries.filter((e) => e !== found);
      persist();
    },
  };
}

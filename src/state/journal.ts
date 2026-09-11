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
  find(row: number): JournalEntry | undefined;
  findByMessage(messageId: number): JournalEntry | undefined;
  remove(row: number): void;
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
      // A freed row can be reused by a later write, so the newest entry for a row wins
      entries = [...entries.filter((e) => e.row !== entry.row), entry].slice(-limit);
      persist();
    },
    last: () => entries.at(-1),
    find: (row) => entries.find((e) => e.row === row),
    findByMessage: (messageId) => entries.find((e) => e.messageId === messageId),
    remove(row) {
      entries = entries.filter((e) => e.row !== row);
      persist();
    },
  };
}

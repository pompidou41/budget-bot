import { randomBytes } from 'crypto';
import type { WrittenRow } from '../sheets/operations.js';
import type { ImportItem } from '../statement/plan.js';
import type { Statement } from '../statement/statement.js';
import { readJson, writeJsonAtomic } from './file.js';

const TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5;

export type ImportStage = 'account' | 'review' | 'done' | 'cancelled' | 'undone';

/** One uploaded statement on its way into «Операции»; bound to its summary message. */
export interface ImportSession {
  id: string;
  chatId: number;
  messageId?: number;
  createdAt: number;
  statement: Statement;
  /** Problems the statement's own running balances revealed (a misread PDF row). */
  problems: string[];
  account: string | null;
  /** Accounts to choose from while `account` is null. */
  candidates: string[];
  stage: ImportStage;
  items: ImportItem[];
  /** HTML lines: sheet operations in the statement's dates that the statement lacks. */
  missing: string[];
  /** The account's balance in «Счета» when the statement was analysed. */
  sheetBalance: number | null;
  written: WrittenRow[];
  busy?: boolean;
}

export interface ImportStore {
  create(chatId: number, statement: Statement, problems: string[]): ImportSession;
  get(id: string): ImportSession | undefined;
  /** Sessions are mutated in place by handlers; this writes them down (once per update). */
  flush(): void;
}

/** Statements in progress survive a deploy: the summary's buttons must keep working. */
export function createImportStore(path = 'data/imports.json'): ImportStore {
  const sessions = new Map<string, ImportSession>();
  const stored = readJson<ImportSession[]>(path, [], 'Imports');
  for (const session of Array.isArray(stored) ? stored : []) {
    if (Date.now() - session.createdAt <= TTL_MS)
      sessions.set(session.id, { ...session, busy: false });
  }

  function sweep(): void {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > TTL_MS) sessions.delete(id);
    }
    // Insertion order is age order: the oldest go first
    for (const id of sessions.keys()) {
      if (sessions.size <= MAX_SESSIONS) break;
      sessions.delete(id);
    }
  }

  return {
    create(chatId, statement, problems) {
      const session: ImportSession = {
        id: randomBytes(4).toString('hex'),
        chatId,
        createdAt: Date.now(),
        statement,
        problems,
        account: null,
        candidates: [],
        stage: 'account',
        items: [],
        missing: [],
        sheetBalance: null,
        written: [],
      };
      sessions.set(session.id, session);
      sweep();
      return session;
    },
    get: (id) => sessions.get(id),
    flush() {
      writeJsonAtomic(path, [...sessions.values()]);
    },
  };
}

import { z } from 'zod/v4';
import { logger } from '../logger.js';
import { readJson, writeJsonAtomic } from './file.js';

/** What the last delivered recap was, so a restart does not send it again. */
export interface RecapState {
  /** Bucket key of the recap that went out, e.g. `2026-10-b1`. */
  lastSent: string | null;
  /** ISO time it went out. */
  sentAt: string | null;
  messageId: number | null;
}

export const EMPTY_RECAP_STATE: RecapState = { lastSent: null, sentAt: null, messageId: null };

const recapSchema = z.object({
  lastSent: z.string().min(1).nullable().catch(null).default(null),
  sentAt: z.string().min(1).nullable().catch(null).default(null),
  messageId: z.number().int().nullable().catch(null).default(null),
});

export interface RecapStore {
  get(): RecapState;
  save(state: RecapState): void;
}

export function createRecapStore(path = 'data/recap.json'): RecapStore {
  let state = load();

  function load(): RecapState {
    const raw = readJson<unknown>(path, undefined, 'Recap state');
    if (raw === undefined) return { ...EMPTY_RECAP_STATE };
    const parsed = recapSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    logger.warn({ path }, 'Recap state is invalid, starting empty');
    return { ...EMPTY_RECAP_STATE };
  }

  return {
    get: () => state,
    save(next) {
      state = next;
      writeJsonAtomic(path, state);
    },
  };
}

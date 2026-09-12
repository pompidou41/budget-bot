import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../logger.js';

/**
 * Reads JSON state written by {@link writeJsonAtomic}. A missing or corrupt file is not an
 * error: the bot must start even after a half-written file or a manual edit, so the caller
 * gets its own empty value instead of an exception.
 */
export function readJson<T>(path: string, fallback: T, describe: string): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    logger.warn({ error, path }, `${describe} is unreadable, starting empty`);
    return fallback;
  }
}

/** Writes to a temp file and renames, so a crash mid-write cannot truncate the state. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

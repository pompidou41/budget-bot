import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { z } from 'zod/v4';
import { DEFAULT_SETTINGS, MAX_ALIASES, type Alias, type Settings } from '../domain/settings.js';
import { logger } from '../logger.js';

const settingsSchema = z.object({
  defaultAccount: z
    .string()
    .min(1)
    .nullable()
    .catch(DEFAULT_SETTINGS.defaultAccount)
    .default(DEFAULT_SETTINGS.defaultAccount),
  aliases: z
    .array(
      z.object({ id: z.string().min(1), phrase: z.string().min(1), meaning: z.string().min(1) }),
    )
    .catch([])
    .default([]),
});

export interface SettingsStore {
  get(): Settings;
  setDefaultAccount(id: string | null): void;
  /** null when the list is already full. */
  addAlias(phrase: string, meaning: string): Alias | null;
  removeAlias(id: string): boolean;
}

export function createSettingsStore(path = 'data/settings.json'): SettingsStore {
  let settings = load();

  function load(): Settings {
    if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) return parsed.data;
      logger.warn({ path }, 'Settings file is invalid, using defaults');
    } catch (error) {
      logger.warn({ error, path }, 'Settings are unreadable, using defaults');
    }
    return { ...DEFAULT_SETTINGS };
  }

  function persist(): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, path);
  }

  return {
    get: () => settings,

    setDefaultAccount(id) {
      settings = { ...settings, defaultAccount: id };
      persist();
    },

    addAlias(phrase, meaning) {
      if (settings.aliases.length >= MAX_ALIASES) return null;
      const alias: Alias = { id: randomBytes(4).toString('hex'), phrase, meaning };
      // Re-defining a phrase replaces it instead of piling up conflicting rules
      const kept = settings.aliases.filter((a) => a.phrase.toLowerCase() !== phrase.toLowerCase());
      settings = { ...settings, aliases: [...kept, alias] };
      persist();
      return alias;
    },

    removeAlias(id) {
      const aliases = settings.aliases.filter((a) => a.id !== id);
      if (aliases.length === settings.aliases.length) return false;
      settings = { ...settings, aliases };
      persist();
      return true;
    },
  };
}

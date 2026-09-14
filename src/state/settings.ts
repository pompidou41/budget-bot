import { randomBytes } from 'crypto';
import { z } from 'zod/v4';
import { DEFAULT_SETTINGS, MAX_NOTES, type Note, type Settings } from '../domain/settings.js';
import { logger } from '../logger.js';
import { readJson, writeJsonAtomic } from './file.js';

const noteSchema = z.object({ id: z.string().min(1), text: z.string().min(1) });

// «фраза = значение» aliases from before notes existed
const legacyAliasSchema = z.object({
  id: z.string().min(1),
  phrase: z.string().min(1),
  meaning: z.string().min(1),
});

const settingsSchema = z.object({
  defaultAccount: z
    .string()
    .min(1)
    .nullable()
    .catch(DEFAULT_SETTINGS.defaultAccount)
    .default(DEFAULT_SETTINGS.defaultAccount),
  notes: z.array(noteSchema).catch([]).default([]),
  aliases: z.array(legacyAliasSchema).catch([]).default([]),
});

function defaults(): Settings {
  return { ...DEFAULT_SETTINGS, notes: [] };
}

/**
 * Old aliases become notes that read the same way to the model («НЗ = T_SAVE»), so nothing the
 * owner already taught the bot is lost. The legacy key disappears on the next write.
 */
function toSettings(parsed: z.infer<typeof settingsSchema>): Settings {
  const known = new Set(parsed.notes.map((note) => note.id));
  const carried = parsed.aliases
    .filter((alias) => !known.has(alias.id))
    .map((alias) => ({ id: alias.id, text: `${alias.phrase} = ${alias.meaning}` }));
  return {
    defaultAccount: parsed.defaultAccount,
    notes: [...parsed.notes, ...carried].slice(0, MAX_NOTES),
  };
}

export interface SettingsStore {
  get(): Settings;
  setDefaultAccount(id: string | null): void;
  /** null when the list is already full. */
  addNote(text: string): Note | null;
  removeNote(id: string): boolean;
}

export function createSettingsStore(path = 'data/settings.json'): SettingsStore {
  let settings = load();

  function load(): Settings {
    const raw = readJson<unknown>(path, undefined, 'Settings');
    if (raw === undefined) return defaults();
    const parsed = settingsSchema.safeParse(raw);
    if (parsed.success) return toSettings(parsed.data);
    logger.warn({ path }, 'Settings file is invalid, using defaults');
    return defaults();
  }

  function persist(): void {
    writeJsonAtomic(path, settings);
  }

  return {
    get: () => settings,

    setDefaultAccount(id) {
      settings = { ...settings, defaultAccount: id };
      persist();
    },

    addNote(text) {
      // The same note sent again moves to the end instead of piling up as a duplicate
      const kept = settings.notes.filter((note) => note.text.toLowerCase() !== text.toLowerCase());
      if (kept.length >= MAX_NOTES) return null;
      const note: Note = { id: randomBytes(4).toString('hex'), text };
      settings = { ...settings, notes: [...kept, note] };
      persist();
      return note;
    },

    removeNote(id) {
      const notes = settings.notes.filter((note) => note.id !== id);
      if (notes.length === settings.notes.length) return false;
      settings = { ...settings, notes };
      persist();
      return true;
    },
  };
}

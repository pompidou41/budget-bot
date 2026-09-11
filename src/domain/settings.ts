/** A phrase the owner uses and what it means: an account ID, a category, any rule for the AI. */
export interface Alias {
  id: string;
  phrase: string;
  meaning: string;
}

/** Owner preferences, editable from /settings and persisted between restarts. */
export interface Settings {
  /** Account put into an expense when the message doesn't name one; null = always ask. */
  defaultAccount: string | null;
  aliases: Alias[];
}

export const DEFAULT_SETTINGS: Settings = { defaultAccount: 'T_MAIN', aliases: [] };

export const MAX_ALIASES = 50;
export const MAX_PHRASE_LENGTH = 64;
export const MAX_MEANING_LENGTH = 160;

// First separator wins: the phrase itself may contain a dash, the meaning may contain anything
const ALIAS_INPUT = /^(.+?)\s*(?:=|→|->|—|–|:)\s*(.+)$/s;

/** «НЗ = T_SAVE» → `{ phrase, meaning }`; null if the format or the lengths are off. */
export function parseAliasInput(text: string): { phrase: string; meaning: string } | null {
  const match = text.trim().match(ALIAS_INPUT);
  if (!match) return null;

  const phrase = match[1]?.trim() ?? '';
  const meaning = match[2]?.trim().replace(/\s+/g, ' ') ?? '';
  if (!phrase || !meaning) return null;
  if (phrase.length > MAX_PHRASE_LENGTH || meaning.length > MAX_MEANING_LENGTH) return null;

  return { phrase, meaning };
}

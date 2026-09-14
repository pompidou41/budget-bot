/**
 * Something the owner wants the AI to know, in their own words: what «НЗ» means, who
 * «Елизавета С.» is, what an account is for, how to treat a kind of payment. Free text on
 * purpose — a strict «фраза = значение» shape could not hold most of what is worth saying.
 */
export interface Note {
  id: string;
  text: string;
}

/** Owner preferences, editable from /settings and persisted between restarts. */
export interface Settings {
  /** Account put into an expense when the message doesn't name one; null = always ask. */
  defaultAccount: string | null;
  notes: Note[];
}

export const DEFAULT_SETTINGS: Settings = { defaultAccount: 'T_MAIN', notes: [] };

export const MAX_NOTES = 50;
/** Room for a paragraph of context, while fifty of them still make a modest prompt. */
export const MAX_NOTE_LENGTH = 500;

/** A note as typed, trimmed; null when there is nothing in it or it is too long to keep. */
export function parseNoteInput(text: string): string | null {
  const note = text.trim();
  if (!note || note.length > MAX_NOTE_LENGTH) return null;
  return note;
}

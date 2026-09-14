import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/ai/parse.js';
import { applyDefaultAccount } from '../src/domain/operation.js';
import {
  DEFAULT_SETTINGS,
  MAX_NOTE_LENGTH,
  MAX_NOTES,
  parseNoteInput,
} from '../src/domain/settings.js';
import { createSettingsStore } from '../src/state/settings.js';
import { expense, ref } from './fixtures.js';

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), 'settings.json');
}

describe('parseNoteInput', () => {
  it('keeps any text the owner writes, not just «фраза = значение»', () => {
    expect(parseNoteInput('НЗ = T_SAVE')).toBe('НЗ = T_SAVE');
    expect(parseNoteInput('  Елизавета С. — моя девушка Лиза  ')).toBe(
      'Елизавета С. — моя девушка Лиза',
    );
    expect(parseNoteInput('Зарплата приходит на Альфу,\nпотом раскладываю по копилкам')).toContain(
      '\n',
    );
  });

  it('rejects an empty note and one too long to keep', () => {
    expect(parseNoteInput('   ')).toBeNull();
    expect(parseNoteInput('я'.repeat(MAX_NOTE_LENGTH + 1))).toBeNull();
    expect(parseNoteInput('я'.repeat(MAX_NOTE_LENGTH))).not.toBeNull();
  });
});

describe('settings store', () => {
  it('starts with T_MAIN as the default payment account', () => {
    expect(DEFAULT_SETTINGS.defaultAccount).toBe('T_MAIN');
    expect(createSettingsStore(storePath()).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists changes and reads them back', () => {
    const path = storePath();
    const store = createSettingsStore(path);
    store.setDefaultAccount('ALFA_MAIN');
    const note = store.addNote('Елизавета С. — моя девушка Лиза');

    const reloaded = createSettingsStore(path).get();
    expect(reloaded.defaultAccount).toBe('ALFA_MAIN');
    expect(reloaded.notes).toEqual([note]);
  });

  it('moves a repeated note to the end instead of duplicating it', () => {
    const store = createSettingsStore(storePath());
    store.addNote('НЗ = T_SAVE');
    store.addNote('Обучение — обязательный платёж');
    store.addNote('нз = t_save');
    expect(store.get().notes.map((n) => n.text)).toEqual([
      'Обучение — обязательный платёж',
      'нз = t_save',
    ]);
  });

  it('removes notes and reports unknown ids', () => {
    const store = createSettingsStore(storePath());
    const note = store.addNote('НЗ = T_SAVE');
    expect(store.removeNote(note!.id)).toBe(true);
    expect(store.removeNote(note!.id)).toBe(false);
    expect(store.get().notes).toEqual([]);
  });

  it('stops adding past the limit', () => {
    const store = createSettingsStore(storePath());
    for (let i = 0; i < MAX_NOTES; i++) store.addNote(`заметка ${i}`);
    expect(store.addNote('ещё одна')).toBeNull();
  });

  it('carries old «фраза = значение» aliases over as notes', () => {
    const path = storePath();
    writeFileSync(
      path,
      JSON.stringify({
        defaultAccount: 'T_MAIN',
        aliases: [{ id: 'ab12', phrase: 'НЗ', meaning: 'T_SAVE' }],
      }),
    );

    const store = createSettingsStore(path);
    expect(store.get().notes).toEqual([{ id: 'ab12', text: 'НЗ = T_SAVE' }]);

    // The next write drops the legacy key; the note survives
    store.setDefaultAccount(null);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('aliases');
    expect(saved.notes).toEqual([{ id: 'ab12', text: 'НЗ = T_SAVE' }]);
  });

  it('falls back to defaults when the file is broken', () => {
    const path = storePath();
    writeFileSync(path, '{ not json');
    expect(createSettingsStore(path).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the file readable as plain JSON', () => {
    const path = storePath();
    createSettingsStore(path).setDefaultAccount(null);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ defaultAccount: null, notes: [] });
  });
});

describe('applyDefaultAccount', () => {
  const op = expense({ account: null });

  it('fills the account of an expense that names none', () => {
    expect(applyDefaultAccount(op, 'T_MAIN', ref).account).toBe('T_MAIN');
  });

  it('never overrides an account the user named', () => {
    expect(applyDefaultAccount(expense({ account: 'ALFA_MAIN' }), 'T_MAIN', ref).account).toBe(
      'ALFA_MAIN',
    );
  });

  it('leaves incomes and transfers alone', () => {
    expect(applyDefaultAccount({ ...op, type: 'Доход' }, 'T_MAIN', ref).account).toBeNull();
    expect(applyDefaultAccount({ ...op, type: 'Перевод' }, 'T_MAIN', ref).account).toBeNull();
  });

  it('ignores a missing, archived or unset default', () => {
    expect(applyDefaultAccount(op, 'GONE', ref).account).toBeNull();
    expect(applyDefaultAccount(op, 'ARCHIVE', ref).account).toBeNull();
    expect(applyDefaultAccount(op, null, ref).account).toBeNull();
  });

  it('skips a default whose currency contradicts the named amount', () => {
    const inUsd = { ...op, mentionedCurrency: 'USD' };
    expect(applyDefaultAccount(inUsd, 'T_MAIN', ref).account).toBeNull();
    expect(applyDefaultAccount(inUsd, 'HEL_MAIN', ref).account).toBe('HEL_MAIN');
  });
});

describe('buildSystemPrompt', () => {
  it('tells the model that bank screenshots run newest first', () => {
    const prompt = buildSystemPrompt(ref, '2026-09-11');
    expect(prompt).toContain('САМАЯ ВЕРХНЯЯ строка — самая свежая операция');
    expect(prompt).toContain('относится к операциям НИЖЕ него');
  });

  it('passes the owner notes verbatim and omits the block when there are none', () => {
    const notes = [
      { id: '1', text: 'НЗ = T_SAVE' },
      { id: '2', text: 'Елизавета С. — моя девушка Лиза,\nпереводы ей — категория Liza' },
    ];
    const prompt = buildSystemPrompt(ref, '2026-09-11', notes);
    expect(prompt).toContain('- НЗ = T_SAVE');
    // A multi-line note stays one bullet, so it cannot break the prompt's structure
    expect(prompt).toContain('- Елизавета С. — моя девушка Лиза, переводы ей — категория Liza');
    expect(buildSystemPrompt(ref, '2026-09-11')).not.toContain('Заметки владельца');
  });
});

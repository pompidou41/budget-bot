import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/ai/parse.js';
import { applyDefaultAccount } from '../src/domain/operation.js';
import { DEFAULT_SETTINGS, MAX_ALIASES, parseAliasInput } from '../src/domain/settings.js';
import { createSettingsStore } from '../src/state/settings.js';
import { expense, ref } from './fixtures.js';

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), 'settings.json');
}

describe('parseAliasInput', () => {
  it('accepts the separators the owner is likely to type', () => {
    for (const text of ['НЗ = T_SAVE', 'НЗ=T_SAVE', 'НЗ → T_SAVE', 'НЗ -> T_SAVE', 'НЗ: T_SAVE']) {
      expect(parseAliasInput(text)).toEqual({ phrase: 'НЗ', meaning: 'T_SAVE' });
    }
  });

  it('splits on the first separator only', () => {
    expect(parseAliasInput('перевод на озон банк самому себе = категория Покупки')).toEqual({
      phrase: 'перевод на озон банк самому себе',
      meaning: 'категория Покупки',
    });
  });

  it('rejects text without a separator, empty sides and overlong parts', () => {
    expect(parseAliasInput('просто текст')).toBeNull();
    expect(parseAliasInput('= T_SAVE')).toBeNull();
    expect(parseAliasInput('НЗ =')).toBeNull();
    expect(parseAliasInput(`${'я'.repeat(65)} = T_SAVE`)).toBeNull();
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
    const alias = store.addAlias('НЗ', 'T_SAVE');

    const reloaded = createSettingsStore(path).get();
    expect(reloaded.defaultAccount).toBe('ALFA_MAIN');
    expect(reloaded.aliases).toEqual([alias]);
  });

  it('replaces an alias when the same phrase is defined again', () => {
    const store = createSettingsStore(storePath());
    store.addAlias('НЗ', 'T_SAVE');
    store.addAlias('нз', 'T_CAR');
    expect(store.get().aliases).toEqual([
      expect.objectContaining({ phrase: 'нз', meaning: 'T_CAR' }),
    ]);
  });

  it('removes aliases and reports unknown ids', () => {
    const store = createSettingsStore(storePath());
    const alias = store.addAlias('НЗ', 'T_SAVE');
    expect(store.removeAlias(alias!.id)).toBe(true);
    expect(store.removeAlias(alias!.id)).toBe(false);
    expect(store.get().aliases).toEqual([]);
  });

  it('stops adding past the limit', () => {
    const store = createSettingsStore(storePath());
    for (let i = 0; i < MAX_ALIASES; i++) store.addAlias(`фраза ${i}`, 'значение');
    expect(store.addAlias('ещё одна', 'значение')).toBeNull();
  });

  it('falls back to defaults when the file is broken', () => {
    const path = storePath();
    writeFileSync(path, '{ not json');
    expect(createSettingsStore(path).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the file readable as plain JSON', () => {
    const path = storePath();
    createSettingsStore(path).setDefaultAccount(null);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ defaultAccount: null, aliases: [] });
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

  it('includes the owner aliases and omits the block when there are none', () => {
    const aliases = [
      { id: '1', phrase: 'НЗ', meaning: 'T_SAVE' },
      { id: '2', phrase: 'перевод на озон банк самому себе', meaning: 'категория Покупки' },
    ];
    const prompt = buildSystemPrompt(ref, '2026-09-11', aliases);
    expect(prompt).toContain('«НЗ» → T_SAVE');
    expect(prompt).toContain('«перевод на озон банк самому себе» → категория Покупки');
    expect(buildSystemPrompt(ref, '2026-09-11')).not.toContain('Личные алиасы');
  });
});

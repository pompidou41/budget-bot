import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { Operation } from '../src/domain/operation.js';
import { createJournal, entryKey } from '../src/state/journal.js';

const op = {} as Operation;
const entry = (row: number, savedAt: string) => ({ row, values: [row], op, savedAt });

describe('journal', () => {
  it('keeps two entries with the same stale row number, found by key', () => {
    const journal = createJournal(join(mkdtempSync(join(tmpdir(), 'j-')), 'j.json'));
    const a = entry(10, '2026-11-23T10:00:00.000Z');
    const b = entry(10, '2026-11-23T11:00:00.000Z');
    journal.add(a);
    journal.add(b);
    expect(journal.find(entryKey(a))).toBe(journal.find(entryKey(a)));
    expect(journal.find(entryKey(a))?.savedAt).toBe(a.savedAt);
    journal.remove(entryKey(a));
    expect(journal.find(entryKey(b))?.savedAt).toBe(b.savedAt);
    expect(journal.find(10)?.savedAt).toBe(b.savedAt);
  });
});

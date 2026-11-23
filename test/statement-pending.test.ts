import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { Existing } from '../src/domain/duplicates.js';
import { createImportStore, type ImportSession } from '../src/state/imports.js';
import { splitUnmatched } from '../src/statement/plan.js';
import type { Statement } from '../src/statement/statement.js';
import { renderImportList, renderImportSummary } from '../src/statement/summary.js';
import { ref, statementRow } from './statement-helpers.js';

const statement: Statement = {
  holder: 'T',
  iban: 'GE00',
  currency: 'GEL',
  from: '2026-10-01',
  to: null,
  opening: 0,
  closing: 175.51,
  rows: [statementRow({ postedDate: '2026-10-10', date: '2026-10-09' })],
};

function sheetRow(row: number, date: string, amount: number): Existing {
  return {
    op: {
      date,
      type: 'Расход',
      account: 'CREDO_GEL',
      amount,
      toAccount: null,
      received: null,
      comment: 'x',
    },
    source: { kind: 'row', row },
  };
}

function session(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    id: 'abc',
    chatId: 1,
    createdAt: Date.now(),
    statement,
    problems: [],
    account: 'CREDO_GEL',
    candidates: [],
    stage: 'review',
    items: [],
    missing: [],
    pending: [],
    pendingEffect: 0,
    sheetBalance: 150,
    written: [],
    ...overrides,
  };
}

describe('pending operations', () => {
  it('splits unmatched sheet rows into missing and pending, with no upper bound', () => {
    const recorded = [
      sheetRow(1, '2026-10-02', 5), // old, inside the statement dates: missing
      sheetRow(2, '2026-10-08', 20), // within a week of the end: pending
      sheetRow(3, '2026-10-12', 5.51), // after the last statement row: pending
      sheetRow(4, '2026-10-12', 9), // matched: neither
    ];
    const dates = { from: '2026-10-01', to: '2026-10-09' };
    const result = splitUnmatched(recorded, new Set([4]), 'CREDO_GEL', statement, dates);
    expect(result.missing.map((m) => m.source)).toEqual([{ kind: 'row', row: 1 }]);
    expect(result.pending.map((m) => m.source)).toEqual([
      { kind: 'row', row: 2 },
      { kind: 'row', row: 3 },
    ]);
  });

  const pending = ['10.10 −20.00 GEL · Wolt', '12.10 −5.51 GEL · Spar'];

  it('explains the gap by pending purchases', () => {
    const text = renderImportSummary(session({ pending, pendingEffect: -25.51 }));
    expect(text).toContain('⏳ Ещё не списаны банком — 2: −25,51 GEL');
    expect(text).toContain('заблокированы или после выписки');
    expect(text).toContain('✅ сходится без учёта ещё не списанных (−25,51)');
  });

  it('keeps the gap and names the pending part when it does not explain all', () => {
    const text = renderImportSummary(
      session({ sheetBalance: 140, pending, pendingEffect: -25.51 }),
    );
    expect(text).toContain('расхождение 35,51 GEL; из них −25,51 — ещё не списанные');
  });

  it('says plain «сходится» without a gap and plain «расхождение» without pending', () => {
    expect(renderImportSummary(session({ sheetBalance: 175.51 }))).toContain('— ✅ сходится');
    const text = renderImportSummary(session());
    expect(text).toContain('расхождение 25,51 GEL');
    expect(text).not.toContain('⏳');
  });

  it('lists pending rows in the full list and loads old sessions without the fields', () => {
    expect(renderImportList(session({ pending }), ref).join('\n')).toContain('⏳ Ещё не списаны');
    const dir = mkdtempSync(join(tmpdir(), 'imports-'));
    const path = join(dir, 'imports.json');
    const { pending: _p, pendingEffect: _e, ...old } = session();
    writeFileSync(path, JSON.stringify([old]));
    const loaded = createImportStore(path).get('abc')!;
    expect(loaded.pending).toEqual([]);
    expect(renderImportSummary(loaded)).toContain('расхождение 25,51 GEL');
  });
});

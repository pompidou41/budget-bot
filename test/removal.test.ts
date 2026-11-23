import { describe, expect, it } from 'vitest';
import { diffRemoval } from '../src/domain/removal.js';
import type { CellValue } from '../src/domain/operation.js';
import { removeVerified, type DeleteIo } from '../src/sheets/verified-delete.js';
import { renderImportUndoPreview } from '../src/statement/undo-preview.js';
import { ref } from './fixtures.js';

const header = ['Дата'];
const row = (amount: number, comment = 'x'): CellValue[] => [
  '2026-11-01',
  'Расход',
  'T_MAIN',
  amount,
  '',
  '',
  'Food',
  '',
  comment,
  false,
  '',
  46000 + amount,
];
const [a, b, c] = [row(1), row(2), row(3)];

describe('diffRemoval', () => {
  it('exact removal is clean', () => {
    expect(diffRemoval([header, a, b, c], [header, a, [], c], [b])).toEqual({
      extra: [],
      stillPresent: [],
    });
  });

  it('reports a row that vanished by accident', () => {
    const diff = diffRemoval([header, a, b, c], [header, [], b, []], [c]);
    expect(diff.extra).toEqual([a]);
    expect(diff.stillPresent).toEqual([]);
  });

  it('reports an expected row that is still there', () => {
    const diff = diffRemoval([header, a, b], [header, [], b], [b]);
    expect(diff.extra).toEqual([a]);
    expect(diff.stillPresent).toEqual([b]);
  });

  it('counts duplicates as a multiset', () => {
    expect(diffRemoval([a, a, b], [a, b], [a])).toEqual({ extra: [], stillPresent: [] });
    expect(diffRemoval([a, a, b], [b], [a])).toEqual({ extra: [a], stillPresent: [] });
  });

  it('ignores empty rows and rows added meanwhile', () => {
    expect(diffRemoval([a, [], b], [a, c, [false]], [b])).toEqual({ extra: [], stillPresent: [] });
  });
});

/** A sheet where `race` replaces what a clear of one row number really hits. */
function fakeIo(sheet: unknown[][], race?: (rows: number[]) => number[]): DeleteIo {
  return {
    read: async () => sheet.map((r) => [...r]),
    clear: async (rows) => {
      for (const r of race ? race(rows) : rows) sheet[r - 1] = [];
    },
    write: async (places) => {
      for (const p of places) sheet[p.row - 1] = p.cells;
    },
  };
}

describe('removeVerified', () => {
  it('removes exactly the target', async () => {
    const sheet: unknown[][] = [header, a, b, c];
    const result = await removeVerified(fakeIo(sheet), [{ row: 3, values: b }]);
    expect(result.removed).toEqual([{ row: 3, values: b }]);
    expect(result.collateral).toEqual([]);
    expect(sheet[2]).toEqual([]);
  });

  it('leaves rows it cannot find exactly once alone', async () => {
    // The saved row number now holds another row and two identical rows exist: no guessing
    const sheet: unknown[][] = [header, a, a, c];
    const result = await removeVerified(fakeIo(sheet), [{ row: 4, values: a }]);
    expect(result.notFound).toHaveLength(1);
    expect(sheet).toEqual([header, a, a, c]);
  });

  it('puts back a row hit by a re-sort and reports the target as still present', async () => {
    const sheet: unknown[][] = [header, a, b, c];
    // The owner re-sorted: the cleared row number now holds another row
    const result = await removeVerified(
      fakeIo(sheet, () => [2]),
      [{ row: 3, values: b }],
    );
    expect(result.removed).toEqual([]);
    expect(result.stillPresent).toHaveLength(1);
    expect(result.collateral).toEqual([{ cells: a, restoredTo: 2 }]);
    expect(sheet).toEqual([header, a, b, c]);
  });

  it('does not write back a row the owner edited by hand meanwhile', async () => {
    const sheet: unknown[][] = [header, a, b, c];
    const edited = row(1, 'edited');
    const io = fakeIo(sheet);
    const clear = io.clear;
    // The target is cleared as asked, and at the same moment the owner edits row 2
    io.clear = async (rows) => {
      await clear(rows);
      sheet[1] = edited;
    };
    const result = await removeVerified(io, [{ row: 3, values: b }]);
    expect(result.removed).toEqual([{ row: 3, values: b }]);
    expect(result.collateral).toEqual([]);
    expect(sheet).toEqual([header, edited, [], c]);
  });
});

describe('renderImportUndoPreview', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    row: i + 2,
    cells: row(i + 1, 'комментарий'.repeat(5)),
  }));

  it('totals per currency and cuts a long list', () => {
    const text = renderImportUndoPreview(rows, 62, ref);
    expect(text).toContain('удалено строк: <b>60</b> из 62');
    expect(text).toContain('Остальные 2 не нашёл');
    expect(text).toMatch(/…и ещё \d+/);
    expect(text.length).toBeLessThan(4096);
  });
});

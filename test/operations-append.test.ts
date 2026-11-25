import type { sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';
import { createOperationsRepo } from '../src/sheets/operations.js';

/** Fake Sheets API with a grid that, like the real one, rejects writes past its last row. */
function fakeSheets(dataRows: number, rowCount: number) {
  const grid = { rowCount };
  const calls: string[] = [];
  const columnA = [['Дата'], ...Array.from({ length: dataRows }, () => ['2026-11-01'])];
  const sheets = {
    spreadsheets: {
      get: async () => {
        calls.push('get');
        return {
          data: {
            sheets: [
              { properties: { sheetId: 7, title: 'Операции', gridProperties: { ...grid } } },
            ],
          },
        };
      },
      batchUpdate: async ({ requestBody }: sheets_v4.Params$Resource$Spreadsheets$Batchupdate) => {
        const grow = requestBody?.requests?.[0]?.appendDimension;
        if (grow) {
          calls.push(`grow ${grow.length}`);
          grid.rowCount += grow.length ?? 0;
        }
        return { data: {} };
      },
      values: {
        get: async () => ({ data: { values: columnA } }),
        update: async ({ range }: { range: string }) => {
          const row = Number(/A(\d+):/.exec(range)?.[1]);
          if (row > grid.rowCount)
            throw new Error(`Range exceeds grid limits. Max rows: ${grid.rowCount}`);
          calls.push(`write ${row}`);
          return { data: {} };
        },
      },
    },
  } as unknown as sheets_v4.Sheets;
  return { sheets, calls };
}

describe('operations append', () => {
  it('grows a full sheet before writing one operation', async () => {
    // Live failure 2026-11-25: 6150 operations filled the 6151-row grid exactly
    const { sheets, calls } = fakeSheets(6150, 6151);
    const result = await createOperationsRepo(sheets, 'id').append(['2026-11-25', 'Доход']);
    expect(result.row).toBe(6152);
    expect(calls.indexOf('grow 1')).toBeGreaterThan(-1);
    expect(calls.indexOf('grow 1')).toBeLessThan(calls.indexOf('write 6152'));
  });

  it('does not grow a sheet that has room', async () => {
    const { sheets, calls } = fakeSheets(10, 100);
    await createOperationsRepo(sheets, 'id').append(['2026-11-25', 'Доход']);
    expect(calls.some((c) => c.startsWith('grow'))).toBe(false);
    expect(calls).toContain('write 12');
  });
});

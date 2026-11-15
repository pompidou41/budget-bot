import type { sheets_v4 } from 'googleapis';
import type { Workbook } from '../domain/document.js';

/** Sheet ids never change and titles rarely do: an hour of cache saves a call per /document. */
const TTL_MS = 60 * 60 * 1000;

export interface WorkbookStore {
  /** Title and tabs of the spreadsheet; the last good answer when Sheets fails. */
  get(): Promise<Workbook>;
}

export function createWorkbookStore(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): WorkbookStore {
  let cached: { at: number; workbook: Workbook } | undefined;

  async function load(): Promise<Workbook> {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties(sheetId,title,hidden)',
    });
    return {
      title: meta.data.properties?.title ?? '',
      tabs: (meta.data.sheets ?? []).flatMap(({ properties: p }) =>
        p?.sheetId == null || p.hidden ? [] : [{ gid: p.sheetId, title: p.title ?? '' }],
      ),
    };
  }

  return {
    async get() {
      if (cached && Date.now() - cached.at < TTL_MS) return cached.workbook;
      try {
        cached = { at: Date.now(), workbook: await load() };
        return cached.workbook;
      } catch (error) {
        if (cached) return cached.workbook;
        throw error;
      }
    },
  };
}

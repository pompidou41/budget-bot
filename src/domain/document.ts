import { escapeHtml } from './format.js';

export interface Workbook {
  title: string;
  tabs: { gid: number; title: string }[];
}

export interface DocumentLink {
  label: string;
  url: string;
}

/** Sheets worth a button of their own, in this order; the rest are one tap away in the table. */
const SHORTCUTS = ['Операции', 'Дашборд', 'Капитал', 'Недели', 'Счета'];

export function spreadsheetUrl(spreadsheetId: string, gid?: number): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return gid === undefined ? base : `${base}#gid=${gid}`;
}

/** The /document message: the table's link and a button per known sheet that exists. */
export function documentView(
  spreadsheetId: string,
  workbook: Workbook | null,
): { text: string; links: DocumentLink[] } {
  const title = workbook?.title ? `«${escapeHtml(workbook.title)}»` : 'с операциями';
  const tabs = SHORTCUTS.flatMap((name) => {
    const tab = workbook?.tabs.find((t) => t.title === name);
    return tab ? [{ label: name, url: spreadsheetUrl(spreadsheetId, tab.gid) }] : [];
  });
  return {
    text: `📗 Таблица ${title}\n${spreadsheetUrl(spreadsheetId)}`,
    links: [{ label: '📗 Открыть таблицу', url: spreadsheetUrl(spreadsheetId) }, ...tabs],
  };
}

import readXlsxFile from 'read-excel-file/node';
import {
  parseMoney,
  parseStatementDate,
  purchaseDate,
  StatementFormatError,
  type Statement,
  type StatementRow,
} from './statement.js';

export interface SheetTable {
  name: string;
  rows: unknown[][];
}

export async function readWorkbook(file: Buffer): Promise<SheetTable[]> {
  const sheets = await readXlsxFile(file);
  return sheets.map((sheet) => ({ name: sheet.sheet, rows: sheet.data as unknown[][] }));
}

type Column =
  | 'date'
  | 'debit'
  | 'credit'
  | 'balance'
  | 'operation'
  | 'description'
  | 'counterparty'
  | 'counterpartyAccount';

// English headers as Credo (myCredo) exports them; Georgian ones as other Georgian banks may
const HEADERS: Record<Column, RegExp> = {
  date: /^(date|თარიღი)$/i,
  debit: /turnover \(db\)|^debit|დებეტი/i,
  credit: /turnover \(cr\)|^credit|კრედიტი/i,
  balance: /^balance|ნაშთი/i,
  operation: /^operation|ოპერაციის ტიპი/i,
  description: /^description|დანიშნულება/i,
  counterparty: /beneficiary name|ბენეფიციარის სახელი/i,
  counterpartyAccount: /beneficiary account|ბენეფიციარის ანგარიში/i,
};

type ColumnMap = Partial<Record<Column, number>>;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function columnsOf(row: unknown[]): ColumnMap | null {
  const map: ColumnMap = {};
  row.forEach((cell, i) => {
    const title = cellText(cell);
    for (const [column, pattern] of Object.entries(HEADERS) as [Column, RegExp][]) {
      if (map[column] === undefined && pattern.test(title)) map[column] = i;
    }
  });
  const complete = map.date !== undefined && map.debit !== undefined && map.credit !== undefined;
  return complete ? map : null;
}

function findTable(tables: SheetTable[]): { rows: unknown[][]; header: number; map: ColumnMap } {
  for (const table of tables) {
    for (const [header, row] of table.rows.entries()) {
      const map = columnsOf(row);
      if (map) return { rows: table.rows, header, map };
    }
  }
  throw new StatementFormatError('Не нашёл таблицу операций с колонками даты, дебета и кредита');
}

function toRow(cells: unknown[], map: ColumnMap, index: number): StatementRow | null {
  const at = (column: Column) => (map[column] === undefined ? undefined : cells[map[column]]);
  const postedDate = parseStatementDate(at('date'));
  const debit = parseMoney(at('debit')) ?? 0;
  const credit = parseMoney(at('credit')) ?? 0;
  // Totals and blank lines have no date or no turnover
  if (!postedDate || (debit <= 0 && credit <= 0)) return null;

  const description = cellText(at('description'));
  return {
    index,
    postedDate,
    date: purchaseDate(description) ?? postedDate,
    direction: debit > 0 ? 'out' : 'in',
    amount: debit > 0 ? debit : credit,
    balance: parseMoney(at('balance')),
    operation: cellText(at('operation')),
    description,
    counterparty: cellText(at('counterparty')),
    counterpartyAccount: cellText(at('counterpartyAccount')),
  };
}

/** «Account Currency» → «GEL», wherever the pair sits in the workbook. */
function details(tables: SheetTable[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const table of tables) {
    for (const row of table.rows) {
      const key = cellText(row[0]).toLowerCase();
      const value = cellText(row[1]);
      if (key && value && !found.has(key)) found.set(key, value);
    }
  }
  return found;
}

function period(text: string | undefined): { from: string | null; to: string | null } {
  const [from, to] = (text ?? '').split(/\s*-\s*/);
  return { from: parseStatementDate(from ?? ''), to: parseStatementDate(to ?? '') };
}

/** A statement export: account details on one sheet, the operations table on another. */
export function parseWorkbook(tables: SheetTable[]): Statement {
  const { rows, header, map } = findTable(tables);
  const parsed: StatementRow[] = [];
  for (const cells of rows.slice(header + 1)) {
    const row = toRow(cells, map, parsed.length + 1);
    if (row) parsed.push(row);
  }
  if (parsed.length === 0) throw new StatementFormatError('В таблице операций нет ни одной строки');

  const info = details(tables);
  const currency = (info.get('account currency') ?? info.get('currency') ?? '').toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(currency)) {
    throw new StatementFormatError('Не нашёл валюту счёта в выписке');
  }
  return {
    holder: info.get('account holder') ?? '',
    iban: (info.get('account number') ?? info.get('iban') ?? '').replace(/\s/g, ''),
    currency,
    ...period(info.get('statement period')),
    opening: parseMoney(info.get('opening balance')),
    closing: parseMoney(info.get('closing balance')),
    rows: parsed,
  };
}

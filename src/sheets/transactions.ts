import type { sheets_v4 } from 'googleapis';
import type { TransactionType } from '../config/categories.js';
import { logger } from '../logger.js';

const TRANSACTIONS_SHEET = 'Операции';

export interface Transaction {
  date: string;
  type: TransactionType;
  category: string;
  amount: number;
  comment: string;
}

export async function appendTransaction(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  transaction: Transaction,
): Promise<void> {
  const row = [
    transaction.date,
    transaction.type === 'expense' ? 'Расход' : 'Доход',
    transaction.category,
    transaction.amount,
    transaction.comment,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TRANSACTIONS_SHEET}!A:E`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row],
    },
  });

  logger.info({ transaction }, 'Transaction appended to sheet');
}

export async function getTransactions(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  startDate?: string,
  endDate?: string,
): Promise<Transaction[]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TRANSACTIONS_SHEET}!A2:E`,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    return [];
  }

  const transactions: Transaction[] = rows
    .map((row) => ({
      date: row[0] as string,
      type: (row[1] === 'Расход' ? 'expense' : 'income') as TransactionType,
      category: row[2] as string,
      amount: parseFloat(row[3] as string),
      comment: (row[4] as string) || '',
    }))
    .filter((t) => !isNaN(t.amount));

  if (startDate || endDate) {
    return transactions.filter((t) => {
      if (startDate && t.date < startDate) return false;
      if (endDate && t.date > endDate) return false;
      return true;
    });
  }

  return transactions;
}

export async function deleteLastTransaction(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<Transaction | null> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TRANSACTIONS_SHEET}!A2:E`,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    return null;
  }

  const lastRow = rows[rows.length - 1]!;
  const transaction: Transaction = {
    date: lastRow[0] as string,
    type: (lastRow[1] === 'Расход' ? 'expense' : 'income') as TransactionType,
    category: lastRow[2] as string,
    amount: parseFloat(lastRow[3] as string),
    comment: (lastRow[4] as string) || '',
  };

  const rowIndex = rows.length + 1;
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${TRANSACTIONS_SHEET}!A${rowIndex}:E${rowIndex}`,
  });

  logger.info({ transaction }, 'Last transaction deleted');
  return transaction;
}

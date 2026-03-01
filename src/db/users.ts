import { getDb } from './index.js';
import type { UserRecord } from './types.js';

interface DbRow {
  telegram_id: number;
  sheet_id: string;
  sheet_url: string;
  expense_categories: string;
  income_categories: string;
  categories_source: string;
  registered_at: string;
  updated_at: string;
}

function toRecord(row: DbRow): UserRecord {
  return {
    telegramId: row.telegram_id,
    sheetId: row.sheet_id,
    sheetUrl: row.sheet_url,
    expenseCategories: JSON.parse(row.expense_categories) as string[],
    incomeCategories: JSON.parse(row.income_categories) as string[],
    categoriesSource: row.categories_source as 'parsed' | 'default',
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

export function findUser(telegramId: number): UserRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as
    | DbRow
    | undefined;
  return row ? toRecord(row) : null;
}

export function createUser(
  data: Pick<
    UserRecord,
    | 'telegramId'
    | 'sheetId'
    | 'sheetUrl'
    | 'expenseCategories'
    | 'incomeCategories'
    | 'categoriesSource'
  >,
): UserRecord {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (telegram_id, sheet_id, sheet_url, expense_categories, income_categories, categories_source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    data.telegramId,
    data.sheetId,
    data.sheetUrl,
    JSON.stringify(data.expenseCategories),
    JSON.stringify(data.incomeCategories),
    data.categoriesSource,
  );
  return findUser(data.telegramId)!;
}

export function updateUser(
  telegramId: number,
  data: Partial<
    Pick<
      UserRecord,
      'sheetId' | 'sheetUrl' | 'expenseCategories' | 'incomeCategories' | 'categoriesSource'
    >
  >,
): UserRecord {
  const db = getDb();
  const fields: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (data.sheetId !== undefined) {
    fields.push('sheet_id = ?');
    values.push(data.sheetId);
  }
  if (data.sheetUrl !== undefined) {
    fields.push('sheet_url = ?');
    values.push(data.sheetUrl);
  }
  if (data.expenseCategories !== undefined) {
    fields.push('expense_categories = ?');
    values.push(JSON.stringify(data.expenseCategories));
  }
  if (data.incomeCategories !== undefined) {
    fields.push('income_categories = ?');
    values.push(JSON.stringify(data.incomeCategories));
  }
  if (data.categoriesSource !== undefined) {
    fields.push('categories_source = ?');
    values.push(data.categoriesSource);
  }

  values.push(telegramId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE telegram_id = ?`).run(...values);
  return findUser(telegramId)!;
}

export function deleteUser(telegramId: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM users WHERE telegram_id = ?').run(telegramId);
  return result.changes > 0;
}

export function getAllUsers(): UserRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users').all() as DbRow[];
  return rows.map(toRecord);
}

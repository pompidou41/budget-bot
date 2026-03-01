import type Database from 'better-sqlite3';

export function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id        INTEGER PRIMARY KEY,
      sheet_id           TEXT NOT NULL,
      sheet_url          TEXT NOT NULL,
      expense_categories TEXT NOT NULL DEFAULT '[]',
      income_categories  TEXT NOT NULL DEFAULT '[]',
      categories_source  TEXT NOT NULL DEFAULT 'default',
      registered_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

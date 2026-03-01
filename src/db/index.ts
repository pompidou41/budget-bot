import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createTables } from './schema.js';
import { logger } from '../logger.js';

let dbInstance: Database.Database | null = null;

export function initDb(dbPath = 'data/budget-bot.db'): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  createTables(dbInstance);
  logger.info({ dbPath }, 'SQLite database initialized');

  return dbInstance;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

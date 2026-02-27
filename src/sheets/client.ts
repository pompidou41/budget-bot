import { google, sheets_v4 } from 'googleapis';
import type { Env } from '../config/index.js';
import { logger } from '../logger.js';

let sheetsInstance: sheets_v4.Sheets | null = null;

export function initSheets(env: Env): sheets_v4.Sheets {
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsInstance = google.sheets({ version: 'v4', auth });
  logger.info('Google Sheets client initialized');

  return sheetsInstance;
}

export function getSheets(): sheets_v4.Sheets {
  if (!sheetsInstance) {
    throw new Error('Google Sheets client not initialized. Call initSheets() first.');
  }
  return sheetsInstance;
}

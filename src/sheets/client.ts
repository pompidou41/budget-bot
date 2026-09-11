import { google, sheets_v4 } from 'googleapis';
import type { Env } from '../config/index.js';
import { logger } from '../logger.js';

export function initSheets(
  env: Pick<Env, 'GOOGLE_SERVICE_ACCOUNT_EMAIL' | 'GOOGLE_PRIVATE_KEY'>,
): sheets_v4.Sheets {
  const auth = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  logger.info('Google Sheets client initialized');
  return google.sheets({ version: 'v4', auth });
}

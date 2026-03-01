import { loadEnv } from './config/index.js';
import { initSheets } from './sheets/index.js';
import { initDb } from './db/index.js';
import { createBot } from './bot/index.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info('Configuration loaded');

  initDb();
  logger.info('Database initialized');

  initSheets(env);
  logger.info('Google Sheets connected');

  const bot = createBot(env);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    bot.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Starting bot...');
  await bot.start();
}

main().catch((error) => {
  logger.fatal({ error }, 'Failed to start bot');
  process.exit(1);
});

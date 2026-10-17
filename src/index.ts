import { createAnalyst } from './ai/analyst.js';
import { createParser } from './ai/parse.js';
import { createTranscriber } from './ai/transcribe.js';
import { createMemoApi, listen, MIN_TOKEN_LENGTH } from './api/server.js';
import { askFinance } from './ai/ask.js';
import { createDatasetStore } from './analytics/dataset.js';
import { buildBalances, buildSummary } from './analytics/summary.js';
import { renderAnswerPlain } from './domain/answer.js';
import { todayIn } from './domain/dates.js';
import type { AppDeps } from './bot/deps.js';
import { createDraftStore } from './bot/drafts.js';
import { BOT_COMMANDS } from './bot/handlers/commands.js';
import { createBot } from './bot/index.js';
import { sendRecap } from './bot/recap.js';
import { loadEnv } from './config/index.js';
import { logger } from './logger.js';
import { initSheets } from './sheets/client.js';
import { createOperationsRepo } from './sheets/operations.js';
import { createRecapScheduler } from './scheduler/recap.js';
import { createReferenceStore } from './sheets/reference.js';
import { checkOperationsHeader } from './sheets/schema-check.js';
import { createConversations } from './state/conversations.js';
import { createJournal } from './state/journal.js';
import { createRecapStore } from './state/recap.js';
import { createSettingsStore } from './state/settings.js';

/** The read-only API for memo-bot; off without a token, and never on a weak one. */
async function startMemoApi(deps: AppDeps) {
  const { MEMO_API_TOKEN: token, MEMO_API_PORT: port, BOT_TIMEZONE: timeZone } = deps.env;
  if (!token) return undefined;
  if (token.length < MIN_TOKEN_LENGTH) {
    logger.error(`MEMO_API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters, API not started`);
    return undefined;
  }

  const api = createMemoApi({
    token,
    handlers: {
      async ask(question) {
        const answer = await askFinance(deps, question);
        return answer
          ? renderAnswerPlain(answer)
          : 'В листе «Операции» пока нет данных для анализа.';
      },
      async summary(period, days) {
        return buildSummary(await deps.data.get(), period, todayIn(timeZone), days);
      },
      async balances() {
        return buildBalances(await deps.refs.get());
      },
    },
  });

  try {
    await listen(api, port);
    logger.info({ port }, 'Memo API listening on 127.0.0.1');
    return api;
  } catch (error) {
    // A busy port must not take the bookkeeping bot down with it
    logger.error({ error, port }, 'Memo API failed to start');
    return undefined;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  logger.level = env.LOG_LEVEL;
  logger.info('Configuration loaded');

  const sheets = initSheets(env);
  const refs = createReferenceStore(sheets, env.SPREADSHEET_ID);

  const deps: AppDeps = {
    env,
    refs,
    data: createDatasetStore(sheets, env.SPREADSHEET_ID),
    repo: createOperationsRepo(sheets, env.SPREADSHEET_ID),
    journal: createJournal(),
    settings: createSettingsStore(),
    parser: createParser({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL,
      timeZone: env.BOT_TIMEZONE,
    }),
    analyst: createAnalyst({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_ANALYST_MODEL ?? env.OPENROUTER_MODEL,
      timeZone: env.BOT_TIMEZONE,
    }),
    transcribe: createTranscriber({ apiKey: env.GROQ_API_KEY, model: env.GROQ_STT_MODEL }),
    drafts: createDraftStore(),
    conversations: createConversations(),
    health: { headerProblems: [] },
    checkHeader: () => checkOperationsHeader(sheets, env.SPREADSHEET_ID),
  };

  try {
    await refs.get();
  } catch (error) {
    logger.error({ error }, 'Failed to load reference data, will retry on demand');
  }

  try {
    deps.health.headerProblems = await deps.checkHeader();
  } catch (error) {
    logger.error({ error }, 'Failed to read «Операции» header');
    deps.health.headerProblems = ['Не удалось прочитать шапку листа «Операции»'];
  }

  const bot = createBot(deps);

  try {
    // Commands are visible only in the owner's chat
    await bot.api.deleteMyCommands();
    await bot.api.setMyCommands(BOT_COMMANDS, {
      scope: { type: 'chat', chat_id: env.OWNER_TELEGRAM_ID },
    });
    logger.info('Bot commands registered');
  } catch (error) {
    logger.warn({ error }, 'Failed to register bot commands');
  }

  if (deps.health.headerProblems.length > 0) {
    logger.error({ problems: deps.health.headerProblems }, 'Writes disabled: header mismatch');
    await bot.api
      .sendMessage(
        env.OWNER_TELEGRAM_ID,
        '⚠️ Запись в таблицу отключена — шапка листа «Операции» не совпадает:\n' +
          `${deps.health.headerProblems.join('\n')}\n\nИсправь и нажми /refresh.`,
      )
      .catch((error: unknown) => logger.warn({ error }, 'Failed to notify owner'));
  }

  const api = await startMemoApi(deps);

  const recap = createRecapScheduler({
    now: () => new Date(),
    timeZone: env.BOT_TIMEZONE,
    state: createRecapStore(),
    enabled: () => deps.settings.get().recap,
    send: (key) => sendRecap(bot.api, deps, key),
  });
  recap.start();

  const shutdown = () => {
    logger.info('Shutting down...');
    recap.stop();
    api?.close();
    void bot.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Starting bot...');
  await bot.start({
    onStart: (me) => logger.info({ username: me.username }, 'Bot started'),
  });
}

main().catch((error) => {
  logger.fatal({ error }, 'Failed to start bot');
  process.exit(1);
});

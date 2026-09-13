import { Bot, GrammyError, HttpError } from 'grammy';
import { logger } from '../logger.js';
import type { AppDeps } from './deps.js';
import { ownerOnly } from './guard.js';
import { registerAsk } from './handlers/ask.js';
import { registerCommands } from './handlers/commands.js';
import { registerDraftHandlers } from './handlers/draft.js';
import { registerInputHandlers } from './handlers/input.js';
import { registerReport } from './handlers/report.js';
import { registerReview } from './handlers/review.js';
import { registerSettings } from './handlers/settings.js';

const ERROR_TEXT = '⚠️ Что-то пошло не так, попробуй ещё раз.';

export function createBot(deps: AppDeps): Bot {
  const bot = new Bot(deps.env.BOT_TOKEN);

  bot.use(ownerOnly(deps.env.OWNER_TELEGRAM_ID));

  // Handlers mutate Draft objects in place; one write per update keeps disk state in step
  // with memory without threading a save call through every state transition.
  bot.use(async (_ctx, next) => {
    try {
      await next();
    } finally {
      deps.drafts.flush();
    }
  });

  registerCommands(bot, deps);
  // Registers a text middleware for alias input — must stay above the catch-all
  registerSettings(bot, deps);
  // Registers a text middleware for reply-to-answer follow-ups — also above the catch-all
  registerAsk(bot, deps);
  registerReport(bot, deps);
  registerReview(bot, deps);
  registerDraftHandlers(bot, deps);
  // Catch-all for text/voice/photo — must stay last
  registerInputHandlers(bot, deps);

  bot.catch(async ({ ctx, error }) => {
    const updateId = ctx.update.update_id;
    if (error instanceof GrammyError) {
      logger.error({ updateId, description: error.description }, 'Telegram API error');
    } else if (error instanceof HttpError) {
      logger.error({ updateId, error }, 'Telegram HTTP error');
    } else {
      logger.error({ updateId, error }, 'Unhandled bot error');
    }

    try {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: ERROR_TEXT, show_alert: true });
      else if (ctx.chat) await ctx.reply(ERROR_TEXT);
    } catch {
      // Telegram itself may be the failing part — nothing more to do
    }
  });

  return bot;
}

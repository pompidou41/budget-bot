import { Bot, GrammyError, HttpError } from 'grammy';
import { logger } from '../logger.js';
import type { AppDeps } from './deps.js';
import { ownerOnly } from './guard.js';
import { registerCommands } from './handlers/commands.js';
import { registerDraftHandlers } from './handlers/draft.js';
import { registerInputHandlers } from './handlers/input.js';

const ERROR_TEXT = '⚠️ Что-то пошло не так, попробуй ещё раз.';

export function createBot(deps: AppDeps): Bot {
  const bot = new Bot(deps.env.BOT_TOKEN);

  bot.use(ownerOnly(deps.env.OWNER_TELEGRAM_ID));

  registerCommands(bot, deps);
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

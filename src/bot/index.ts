import { Bot } from 'grammy';
import type { Env } from '../config/index.js';
import { authMiddleware } from './middleware/auth.js';
import { startCommand, helpCommand, menuCommand } from './commands/start.js';
import { categoriesCommand } from './commands/categories.js';
import { summaryCommand } from './commands/summary.js';
import { createUndoCommand } from './commands/undo.js';
import { createTransactionHandler, createCallbackHandler } from './handlers/transaction.js';
import { createSummaryCallbackHandler } from './handlers/summary.js';
import { summaryPeriodKeyboard, mainMenuKeyboard } from './keyboards/index.js';

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Auth middleware — only allowed user can use the bot
  bot.use(authMiddleware(env.ALLOWED_USER_ID));

  // Commands
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('menu', menuCommand);
  bot.command('categories', categoriesCommand);
  bot.command('summary', summaryCommand);
  bot.command('undo', createUndoCommand(env));

  // Callback queries — transaction flow
  const txCallbacks = createCallbackHandler(env);
  bot.callbackQuery('tx:confirm', txCallbacks.confirm);
  bot.callbackQuery('tx:cancel', txCallbacks.cancel);
  bot.callbackQuery('tx:change_cat', txCallbacks.changeCategory);
  bot.callbackQuery('tx:back', txCallbacks.back);
  bot.callbackQuery(/^cat:/, txCallbacks.selectCategory);

  // Callback queries — summary
  const summaryCallback = createSummaryCallbackHandler(env);
  bot.callbackQuery(/^summary:/, summaryCallback);

  // Callback queries — main menu
  bot.callbackQuery('back:main_menu', async (ctx) => {
    await ctx.editMessageText('Главное меню:', {
      reply_markup: mainMenuKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('menu:summary', async (ctx) => {
    await ctx.editMessageText('Выберите период для саммари:', {
      reply_markup: summaryPeriodKeyboard('back:main_menu'),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('menu:expenses', async (ctx) => {
    // Redirect to summary with month period
    await ctx.editMessageText('Выберите период:', {
      reply_markup: summaryPeriodKeyboard('back:main_menu'),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('menu:income', async (ctx) => {
    await ctx.editMessageText('Выберите период:', {
      reply_markup: summaryPeriodKeyboard('back:main_menu'),
    });
    await ctx.answerCallbackQuery();
  });

  // Text messages — transaction parsing
  const transactionHandler = createTransactionHandler(env);
  bot.on('message:text', transactionHandler);

  return bot;
}

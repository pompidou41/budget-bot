import { Bot } from 'grammy';
import type { Env } from '../config/index.js';
import { userMiddleware } from './middleware/auth.js';
import { createStartCommand, helpCommand, menuCommand } from './commands/start.js';
import { categoriesCommand } from './commands/categories.js';
import { summaryCommand } from './commands/summary.js';
import { createUndoCommand } from './commands/undo.js';
import { createTransactionHandler, createCallbackHandler } from './handlers/transaction.js';
import { createSummaryCallbackHandler } from './handlers/summary.js';
import {
  handleRegAdded,
  handleRegCatsOk,
  handleRegCatsDefault,
  handleRegistrationText,
} from './handlers/registration.js';
import { summaryPeriodKeyboard, mainMenuKeyboard, MENU_BUTTON_LABEL } from './keyboards/index.js';
import type { BotContext } from './context.js';

export function createBot(env: Env): Bot<BotContext> {
  const bot = new Bot<BotContext>(env.BOT_TOKEN);

  // User middleware — loads user from DB, attaches to ctx.user
  bot.use(userMiddleware());

  // Commands
  bot.command('start', createStartCommand(env));
  bot.command('help', helpCommand);
  bot.command('menu', menuCommand);
  bot.command('categories', categoriesCommand);
  bot.command('summary', summaryCommand);
  bot.command('undo', createUndoCommand());

  // Callback queries — registration flow
  bot.callbackQuery('reg:added', handleRegAdded);
  bot.callbackQuery('reg:cats_ok', handleRegCatsOk);
  bot.callbackQuery('reg:cats_default', handleRegCatsDefault);

  // Callback queries — transaction flow
  const txCallbacks = createCallbackHandler();
  bot.callbackQuery('tx:confirm', txCallbacks.confirm);
  bot.callbackQuery('tx:cancel', txCallbacks.cancel);
  bot.callbackQuery('tx:change_cat', txCallbacks.changeCategory);
  bot.callbackQuery('tx:back', txCallbacks.back);
  bot.callbackQuery(/^cat:/, txCallbacks.selectCategory);

  // Callback queries — summary
  const summaryCallback = createSummaryCallbackHandler();
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

  // Reply keyboard button — must be before message:text catch-all
  bot.hears(MENU_BUTTON_LABEL, async (ctx) => {
    await ctx.reply('Главное меню:', { reply_markup: mainMenuKeyboard() });
  });

  // Registration text handler (sheet URL) — before transaction catch-all
  bot.on('message:text', async (ctx, next) => {
    await handleRegistrationText(ctx, env, next);
  });

  // Text messages — transaction parsing
  const transactionHandler = createTransactionHandler();
  bot.on('message:text', transactionHandler);

  return bot;
}

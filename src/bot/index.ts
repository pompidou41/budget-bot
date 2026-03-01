import { Bot } from 'grammy';
import type { Env } from '../config/index.js';
import { userMiddleware, authGuardMiddleware } from './middleware/auth.js';
import { createStartCommand, helpCommand, menuCommand } from './commands/start.js';
import { categoriesCommand } from './commands/categories.js';
import { summaryCommand } from './commands/summary.js';
import { createUndoCommand } from './commands/undo.js';
import { createTransactionHandler, createCallbackHandler } from './handlers/transaction.js';
import { createSummaryCallbackHandler } from './handlers/summary.js';
import {
  handleRegAdded,
  handleRegCantAdd,
  handleRegCatsOk,
  handleRegCatsDefault,
  handleRegistrationText,
} from './handlers/registration.js';
import {
  startWizard,
  handleWizardDate,
  handleWizardType,
  handleWizardCategory,
  handleWizardSkipComment,
  handleWizardText,
} from './handlers/wizard.js';
import { summaryPeriodKeyboard, mainMenuKeyboard } from './keyboards/index.js';
import type { BotContext } from './context.js';

export function createBot(env: Env): Bot<BotContext> {
  const bot = new Bot<BotContext>(env.BOT_TOKEN);

  // User middleware — loads user from DB, attaches to ctx.user
  bot.use(userMiddleware());

  // Auth guard — blocks unregistered users except for registration flow
  bot.use(authGuardMiddleware());

  // Commands
  bot.command('start', createStartCommand(env));
  bot.command('help', helpCommand);
  bot.command('menu', menuCommand);
  bot.command('categories', categoriesCommand);
  bot.command('summary', summaryCommand);
  bot.command('undo', createUndoCommand());

  // Callback queries — registration flow
  bot.callbackQuery('reg:added', handleRegAdded);
  bot.callbackQuery('reg:cant_add', handleRegCantAdd);
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

  // Callback queries — wizard flow
  bot.callbackQuery('menu:add_tx', startWizard);

  bot.callbackQuery('wzd:date_today', async (ctx) => {
    await handleWizardDate(ctx, 'today');
  });
  bot.callbackQuery('wzd:date_yesterday', async (ctx) => {
    await handleWizardDate(ctx, 'yesterday');
  });
  bot.callbackQuery('wzd:date_custom', async (ctx) => {
    await handleWizardDate(ctx, 'custom');
  });

  bot.callbackQuery('wzd:type_expense', async (ctx) => {
    await handleWizardType(ctx, 'expense');
  });
  bot.callbackQuery('wzd:type_income', async (ctx) => {
    await handleWizardType(ctx, 'income');
  });

  bot.callbackQuery(/^wzd:cat:/, async (ctx) => {
    const category = ctx.callbackQuery?.data?.replace('wzd:cat:', '') || '';
    await handleWizardCategory(ctx, category);
  });

  bot.callbackQuery('wzd:skip_comment', handleWizardSkipComment);

  // Registration text handler (sheet URL) — before transaction catch-all
  bot.on('message:text', async (ctx, next) => {
    await handleRegistrationText(ctx, env, next);
  });

  // Wizard text handler — before transaction catch-all
  bot.on('message:text', async (ctx, next) => {
    await handleWizardText(ctx, next);
  });

  // Text messages — transaction parsing
  const transactionHandler = createTransactionHandler();
  bot.on('message:text', transactionHandler);

  return bot;
}

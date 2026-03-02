import { Bot } from 'grammy';
import type { Env } from '../config/index.js';
import { userMiddleware, authGuardMiddleware } from './middleware/auth.js';
import {
  createStartCommand,
  helpCommand,
  menuCommand,
  reportsCommand,
  settingsCommand,
  operationsCommand,
} from './commands/start.js';
import {
  createUndoPreviewHandler,
  createUndoCallbackPreviewHandler,
  createUndoConfirmHandler,
  createUndoCancelHandler,
} from './commands/undo.js';
import { createTransactionHandler, createCallbackHandler } from './handlers/transaction.js';
import {
  createSummaryCallbackHandler,
  createExpensesCallbackHandler,
  createIncomeCallbackHandler,
  createRecentCallbackHandler,
} from './handlers/summary.js';
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
import {
  summaryPeriodKeyboard,
  expensesPeriodKeyboard,
  incomePeriodKeyboard,
  recentPeriodKeyboard,
  mainMenuKeyboard,
  reportsMenuKeyboard,
  settingsMenuKeyboard,
  operationsMenuKeyboard,
} from './keyboards/index.js';
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
  bot.command('reports', reportsCommand);
  bot.command('settings', settingsCommand);
  bot.command('operations', operationsCommand);
  bot.command('undo', createUndoPreviewHandler());

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

  // Callback queries — summary and reports
  const summaryCallback = createSummaryCallbackHandler();
  bot.callbackQuery(/^summary:/, summaryCallback);
  bot.callbackQuery(/^expenses:/, createExpensesCallbackHandler());
  bot.callbackQuery(/^income:/, createIncomeCallbackHandler());
  bot.callbackQuery(/^recent:/, createRecentCallbackHandler());

  // Callback queries — navigation
  bot.callbackQuery('nav:main_menu', async (ctx) => {
    await ctx.editMessageText('Главное меню:', { reply_markup: mainMenuKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:reports', async (ctx) => {
    await ctx.editMessageText('Отчёты:', { reply_markup: reportsMenuKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:settings', async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery('Ты ещё не зарегистрирован.');
      return;
    }
    await ctx.editMessageText('Настройки:', {
      reply_markup: settingsMenuKeyboard(ctx.user.sheetUrl),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:operations', async (ctx) => {
    await ctx.editMessageText('Операции:', { reply_markup: operationsMenuKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:help', async (ctx) => {
    await ctx.editMessageText(
      `<b>Как пользоваться ботом</b>\n\n` +
        `<b>Запись трат/доходов:</b>\n` +
        `Просто напиши сообщение в формате:\n` +
        `<code>Категория Сумма Комментарий</code>\n\n` +
        `Комментарий — необязателен.\n\n` +
        `<b>Команды:</b>\n` +
        `/menu — главное меню\n` +
        `/reports — отчёты (саммари, траты, доходы)\n` +
        `/operations — добавить или отменить операцию\n` +
        `/settings — категории и ссылка на таблицу\n` +
        `/help — эта справка`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() },
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:categories', async (ctx) => {
    const user = ctx.user;
    if (!user) {
      await ctx.answerCallbackQuery('Ты ещё не зарегистрирован.');
      return;
    }
    const expenseList = user.expenseCategories.map((c) => `• ${c}`).join('\n');
    const incomeList = user.incomeCategories.map((c) => `• ${c}`).join('\n');
    await ctx.editMessageText(
      `<b>Категории расходов:</b>\n${expenseList}\n\n<b>Категории доходов:</b>\n${incomeList}`,
      { parse_mode: 'HTML', reply_markup: settingsMenuKeyboard(user.sheetUrl) },
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:summary', async (ctx) => {
    await ctx.editMessageText('Выберите период для саммари:', {
      reply_markup: summaryPeriodKeyboard('nav:reports'),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:expenses', async (ctx) => {
    await ctx.editMessageText('Все траты — выберите период:', {
      reply_markup: expensesPeriodKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:income', async (ctx) => {
    await ctx.editMessageText('Все доходы — выберите период:', {
      reply_markup: incomePeriodKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery('nav:recent', async (ctx) => {
    await ctx.editMessageText('Последние записи — выберите период:', {
      reply_markup: recentPeriodKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  // Callback queries — undo from operations menu
  bot.callbackQuery('op:undo', createUndoCallbackPreviewHandler());
  bot.callbackQuery('undo:confirm', createUndoConfirmHandler());
  bot.callbackQuery('undo:cancel', createUndoCancelHandler());

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

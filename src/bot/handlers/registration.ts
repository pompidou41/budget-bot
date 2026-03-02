import type { NextFunction } from 'grammy';
import { getSheets } from '../../sheets/client.js';
import { verifySheetAccess, extractSheetIdFromUrl } from '../../sheets/access-check.js';
import { parseBriefCategories } from '../../sheets/brief-parser.js';
import { createUser, updateUser } from '../../db/users.js';
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES } from '../../config/categories.js';
import { registrationAddedKeyboard, categoriesConfirmKeyboard } from '../keyboards/index.js';
import type { BotContext } from '../context.js';
import type { Env } from '../../config/index.js';
import { logger } from '../../logger.js';
import { TELEGRAPH_GUIDE_URL } from '../../config/telegraph.js';

type RegistrationStep = 'awaiting_added' | 'awaiting_sheet_url' | 'awaiting_categories_confirm';

interface RegistrationState {
  step: RegistrationStep;
  sheetId?: string;
  sheetUrl?: string;
  expenseCategories?: string[];
  incomeCategories?: string[];
}

const states = new Map<number, RegistrationState>();

export function hasRegistrationState(userId: number): boolean {
  return states.has(userId);
}

const WELCOME_TEXT =
  `Привет! Я бот для учёта бюджета.\n\n` +
  `Чтобы записать трату, просто напиши сообщение в формате:\n` +
  `<b>Категория Сумма Комментарий</b>\n\n` +
  `Примеры:\n` +
  `• <code>Продукты 1500 Пятёрочка</code>\n` +
  `• <code>Такси 350</code>\n` +
  `• <code>Зарплата 80000</code>\n\n` +
  `Команды:\n` +
  `/menu — главное меню\n` +
  `/summary — саммари за период\n` +
  `/categories — список категорий\n` +
  `/help — справка`;

export async function startRegistration(ctx: BotContext, env: Env): Promise<void> {
  const userId = ctx.from!.id;
  states.set(userId, { step: 'awaiting_added' });

  await ctx.reply(
    `Привет! Я бот для учёта бюджета.\n\n` +
      `Чтобы начать, добавь мой сервисный аккаунт как редактора в свою Google Таблицу:\n\n` +
      `📧 <code>${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}</code>\n\n` +
      `📖 <a href="${TELEGRAPH_GUIDE_URL}">Инструкция по подключению</a>\n\n` +
      `Когда добавишь — нажми кнопку ниже.`,
    { parse_mode: 'HTML', reply_markup: registrationAddedKeyboard() },
  );
}

export async function handleRegAdded(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  states.set(userId, { step: 'awaiting_sheet_url' });
  await ctx.editMessageText(
    `Отлично! Теперь отправь мне ссылку на свою Google Таблицу.\n\n` +
      `📖 <a href="${TELEGRAPH_GUIDE_URL}">Как скопировать ссылку</a>`,
    { parse_mode: 'HTML', reply_markup: undefined },
  );
  await ctx.answerCallbackQuery();
}

export async function handleRegCantAdd(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  states.delete(userId);
  await ctx.editMessageText('Напишите @pompidou17 — помогу настроить таблицу.', {
    reply_markup: undefined,
  });
  await ctx.answerCallbackQuery();
}

export async function handleRegCatsOk(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = states.get(userId);
  if (!state?.sheetId || !state.sheetUrl || !state.expenseCategories || !state.incomeCategories) {
    await ctx.answerCallbackQuery('Ошибка: потеряно состояние. Начни заново — /start');
    return;
  }

  const existing = ctx.user;
  if (existing) {
    updateUser(userId, {
      sheetId: state.sheetId,
      sheetUrl: state.sheetUrl,
      expenseCategories: state.expenseCategories,
      incomeCategories: state.incomeCategories,
      categoriesSource: 'parsed',
    });
  } else {
    createUser({
      telegramId: userId,
      sheetId: state.sheetId,
      sheetUrl: state.sheetUrl,
      expenseCategories: state.expenseCategories,
      incomeCategories: state.incomeCategories,
      categoriesSource: 'parsed',
    });
  }

  states.delete(userId);
  try {
    await ctx.deleteMessage();
  } catch {
    // Message may be too old to delete (Telegram 48h limit) — safe to ignore
  }
  await ctx.answerCallbackQuery('Регистрация завершена!');
  await ctx.reply(WELCOME_TEXT, { parse_mode: 'HTML' });
}

export async function handleRegCatsDefault(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = states.get(userId);
  if (!state?.sheetId || !state.sheetUrl) {
    await ctx.answerCallbackQuery('Ошибка: потеряно состояние. Начни заново — /start');
    return;
  }

  const existing = ctx.user;
  if (existing) {
    updateUser(userId, {
      sheetId: state.sheetId,
      sheetUrl: state.sheetUrl,
      expenseCategories: [...DEFAULT_EXPENSE_CATEGORIES],
      incomeCategories: [...DEFAULT_INCOME_CATEGORIES],
      categoriesSource: 'default',
    });
  } else {
    createUser({
      telegramId: userId,
      sheetId: state.sheetId,
      sheetUrl: state.sheetUrl,
      expenseCategories: [...DEFAULT_EXPENSE_CATEGORIES],
      incomeCategories: [...DEFAULT_INCOME_CATEGORIES],
      categoriesSource: 'default',
    });
  }

  states.delete(userId);
  try {
    await ctx.deleteMessage();
  } catch {
    // Message may be too old to delete (Telegram 48h limit) — safe to ignore
  }
  await ctx.answerCallbackQuery('Регистрация завершена!');
  await ctx.reply(WELCOME_TEXT, { parse_mode: 'HTML' });
}

export async function handleRegistrationText(
  ctx: BotContext,
  env: Env,
  next: NextFunction,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await next();
    return;
  }

  const state = states.get(userId);
  if (!state || state.step !== 'awaiting_sheet_url') {
    await next();
    return;
  }

  const text = ctx.message?.text?.trim();
  if (!text) {
    await next();
    return;
  }

  const sheetId = extractSheetIdFromUrl(text);
  if (!sheetId) {
    await ctx.reply(
      'Не удалось распознать ссылку. Отправь ссылку вида:\n' +
        '<code>https://docs.google.com/spreadsheets/d/...</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const sheets = getSheets();
  const access = await verifySheetAccess(sheets, sheetId);

  if (!access.ok) {
    await ctx.reply(
      `Нет доступа к таблице. Убедись, что добавил\n` +
        `<code>${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}</code>\n` +
        `как редактора.\n\n` +
        `📖 <a href="${TELEGRAPH_GUIDE_URL}">Инструкция по подключению</a>\n\n` +
        `Если проблема не решается — пиши @pompidou17.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  logger.info({ userId, sheetId, title: access.title }, 'Sheet access verified');

  const parsed = await parseBriefCategories(sheets, sheetId);

  if (!parsed || (parsed.expenseCategories.length === 0 && parsed.incomeCategories.length === 0)) {
    // No Сводка sheet or couldn't parse — save with defaults immediately
    const existing = ctx.user;
    if (existing) {
      updateUser(userId, {
        sheetId,
        sheetUrl: text,
        expenseCategories: [...DEFAULT_EXPENSE_CATEGORIES],
        incomeCategories: [...DEFAULT_INCOME_CATEGORIES],
        categoriesSource: 'default',
      });
    } else {
      createUser({
        telegramId: userId,
        sheetId,
        sheetUrl: text,
        expenseCategories: [...DEFAULT_EXPENSE_CATEGORIES],
        incomeCategories: [...DEFAULT_INCOME_CATEGORIES],
        categoriesSource: 'default',
      });
    }

    states.delete(userId);
    await ctx.reply(
      `Таблица «${access.title}» подключена.\n\n` +
        `Лист "Сводка" не найден — использую стандартные категории.\n\n` +
        `Регистрация завершена!`,
    );
    await ctx.reply(WELCOME_TEXT, { parse_mode: 'HTML' });
    return;
  }

  // Store state and ask for confirmation
  states.set(userId, {
    step: 'awaiting_categories_confirm',
    sheetId,
    sheetUrl: text,
    expenseCategories: parsed.expenseCategories,
    incomeCategories: parsed.incomeCategories,
  });

  const expenseList = parsed.expenseCategories.map((c) => `• ${c}`).join('\n');
  const incomeList = parsed.incomeCategories.map((c) => `• ${c}`).join('\n');

  let msg = `Таблица «${access.title}» подключена! Нашёл следующие категории:\n\n`;
  if (expenseList) msg += `<b>Расходы:</b>\n${expenseList}\n\n`;
  if (incomeList) msg += `<b>Доходы:</b>\n${incomeList}\n\n`;
  msg += `Всё верно?`;

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: categoriesConfirmKeyboard(),
  });
}

import type { NextFunction } from 'grammy';
import { findUser } from '../../db/users.js';
import { logger } from '../../logger.js';
import type { BotContext } from '../context.js';
import { hasRegistrationState } from '../handlers/registration.js';

export function userMiddleware() {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;

    if (!userId) {
      await next();
      return;
    }

    const user = findUser(userId);
    if (user) {
      ctx.user = user;
    } else {
      logger.debug({ userId }, 'Unregistered user');
    }

    await next();
  };
}

export function authGuardMiddleware() {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;

    // Allow if user is registered
    if (ctx.user) {
      await next();
      return;
    }

    // Allow if user is in active registration
    if (userId && hasRegistrationState(userId)) {
      await next();
      return;
    }

    // Allow registration callbacks
    if (ctx.callbackQuery?.data?.startsWith('reg:')) {
      await next();
      return;
    }

    // Allow /start command
    if (ctx.message?.text === '/start') {
      await next();
      return;
    }

    // Block everything else for unregistered users
    await ctx.reply('Сначала зарегистрируйся. Нажми /start для регистрации.');
  };
}

import type { NextFunction } from 'grammy';
import { findUser } from '../../db/users.js';
import { logger } from '../../logger.js';
import type { BotContext } from '../context.js';

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

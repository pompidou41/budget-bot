import type { Context, NextFunction } from 'grammy';
import { logger } from '../../logger.js';

export function authMiddleware(allowedUserId: number) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const userId = ctx.from?.id;

    if (!userId || userId !== allowedUserId) {
      logger.warn({ userId }, 'Unauthorized access attempt');
      await ctx.reply('У вас нет доступа к этому боту.');
      return;
    }

    await next();
  };
}

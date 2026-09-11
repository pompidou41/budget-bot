import type { Context, MiddlewareFn } from 'grammy';
import { logger } from '../logger.js';

/** Single-user bot: drop every update that isn't from the owner's private chat. */
export function ownerOnly(ownerId: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const fromOwner = ctx.from?.id === ownerId;
    const privateChat = !ctx.chat || ctx.chat.type === 'private';

    if (!fromOwner || !privateChat) {
      logger.warn({ fromId: ctx.from?.id, chatType: ctx.chat?.type }, 'Ignored update');
      return;
    }
    await next();
  };
}

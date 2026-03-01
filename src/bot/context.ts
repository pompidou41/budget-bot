import type { Context } from 'grammy';
import type { UserRecord } from '../db/types.js';

export interface BotContext extends Context {
  user?: UserRecord;
}

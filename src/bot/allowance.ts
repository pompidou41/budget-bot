import { InlineKeyboard, type Api, type Bot, type Context } from 'grammy';
import {
  allowanceCategory,
  allowanceOperation,
  findSurpluses,
  renderSurplusOffer,
  surplusCents,
  type Surplus,
} from '../domain/allowance.js';
import { renderCard } from '../domain/card.js';
import { nowSerialIn, todayIn } from '../domain/dates.js';
import { toRow, type Operation } from '../domain/operation.js';
import { findAccount, isSettlement, type Reference } from '../domain/reference.js';
import { logger } from '../logger.js';
import { entryKey } from '../state/journal.js';
import type { AppDeps } from './deps.js';
import { savedKeyboard } from './keyboards.js';

const DISMISS = 'al:no';
const BOOK = /^al:([^:]+):(\d+)$/;

function offerKeyboard(surplus: Surplus): InlineKeyboard {
  return new InlineKeyboard()
    .text('💝 Записать на личные', `al:${surplus.account.id}:${surplusCents(surplus)}`)
    .text('Не сейчас', DISMISS);
}

/** Sends one offer per settlement account in plus; `only` limits it to the accounts just touched. */
export async function offerSurpluses(
  api: Api,
  chatId: number,
  deps: AppDeps,
  only?: string[],
): Promise<void> {
  const ref = await deps.refs.reload();
  const surpluses = findSurpluses(ref).filter((s) => !only || only.includes(s.account.id));
  for (const surplus of surpluses) {
    await api.sendMessage(chatId, renderSurplusOffer(surplus), {
      parse_mode: 'HTML',
      reply_markup: offerKeyboard(surplus),
    });
  }
}

function allowanceAccounts(op: Operation, ref: Reference): string[] {
  return [op.account, op.toAccount].filter((id): id is string => {
    const account = id ? findAccount(ref, id) : undefined;
    return account !== undefined && isSettlement(account) && !!allowanceCategory(account, ref);
  });
}

/** After a save that moved such an account; never fails the save that already happened. */
export async function offerAfterSave(
  ctx: Context,
  deps: AppDeps,
  op: Operation,
  ref: Reference,
): Promise<void> {
  const touched = allowanceAccounts(op, ref);
  if (touched.length === 0 || !ctx.chat) return;
  try {
    await offerSurpluses(ctx.api, ctx.chat.id, deps, touched);
  } catch (error) {
    logger.warn({ error, touched }, 'Failed to offer the allowance');
  }
}

async function book(ctx: Context, deps: AppDeps, surplus: Surplus, ref: Reference): Promise<void> {
  const now = new Date();
  const op = allowanceOperation(surplus, todayIn(deps.env.BOT_TIMEZONE, now));
  const values = toRow(op, nowSerialIn(deps.env.BOT_TIMEZONE, now));
  const result = await deps.repo.append(values);
  const entry = {
    row: result.row,
    values,
    op,
    savedAt: now.toISOString(),
    messageId: ctx.callbackQuery?.message?.message_id,
  };
  deps.journal.add(entry);
  await ctx.editMessageText(
    renderCard(op, ref, { footer: `✅ <b>Записано</b> · строка ${result.row}` }),
    { parse_mode: 'HTML', reply_markup: savedKeyboard(entryKey(entry)) },
  );
  await ctx.answerCallbackQuery('Записано');
}

async function onBook(ctx: Context, deps: AppDeps, busy: Set<string>): Promise<void> {
  const [, accountId = '', cents = ''] = ctx.match as RegExpMatchArray;
  if (deps.health.headerProblems.length > 0) {
    await ctx.answerCallbackQuery({
      text: 'Запись отключена: шапка «Операции» не совпадает. Исправь и нажми /refresh.',
      show_alert: true,
    });
    return;
  }
  if (busy.has(accountId)) {
    await ctx.answerCallbackQuery('Уже записываю…');
    return;
  }
  busy.add(accountId);
  try {
    const ref = await deps.refs.reload();
    const surplus = findSurpluses(ref).find((s) => s.account.id === accountId);
    if (!surplus) {
      await ctx.editMessageText('✅ Уже в расчёте — записывать нечего.');
      await ctx.answerCallbackQuery();
    } else if (String(surplusCents(surplus)) !== cents) {
      // The balance moved since the offer: show the new amount instead of booking the old one
      await ctx.editMessageText(renderSurplusOffer(surplus), {
        parse_mode: 'HTML',
        reply_markup: offerKeyboard(surplus),
      });
      await ctx.answerCallbackQuery({ text: 'Сумма изменилась — проверь и нажми ещё раз.' });
    } else {
      await book(ctx, deps, surplus, ref);
    }
  } finally {
    busy.delete(accountId);
  }
}

export function registerAllowance(bot: Bot, deps: AppDeps): void {
  const busy = new Set<string>();
  bot.callbackQuery(BOOK, (ctx) => onBook(ctx, deps, busy));
  bot.callbackQuery(DISMISS, async (ctx) => {
    await ctx.editMessageText('Оставил как есть. Предложу снова в /balance.');
    await ctx.answerCallbackQuery();
  });
}

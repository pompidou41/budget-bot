import type { Bot, Context } from 'grammy';
import { renderCard } from '../../domain/card.js';
import { formatUsd } from '../../domain/format.js';
import { toRow, validate } from '../../domain/operation.js';
import type { Reference } from '../../domain/reference.js';
import { logger } from '../../logger.js';
import type { AppendResult } from '../../sheets/operations.js';
import type { AppDeps } from '../deps.js';
import { applyAction } from '../draft-actions.js';
import type { Draft } from '../drafts.js';
import { savedKeyboard } from '../keyboards.js';
import { renderDraft } from '../render.js';
import { ignoreNotModified } from '../telegram.js';

// Telegram limits callback alerts to 200 characters
const ALERT_LIMIT = 200;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function saveDraft(ctx: Context, deps: AppDeps, draft: Draft, ref: Reference): Promise<void> {
  if (deps.health.headerProblems.length > 0) {
    await ctx.answerCallbackQuery({
      text: 'Запись отключена: шапка листа «Операции» не совпадает с ожидаемой. Исправь и нажми /refresh.',
      show_alert: true,
    });
    return;
  }

  const problems = validate(draft.op, ref);
  if (problems.length > 0) {
    await ctx.answerCallbackQuery({
      text: truncate(problems.join('\n'), ALERT_LIMIT),
      show_alert: true,
    });
    return;
  }

  if (draft.saving) {
    await ctx.answerCallbackQuery('Уже сохраняю…');
    return;
  }
  draft.saving = true;

  const values = toRow(draft.op);
  let result: AppendResult;
  try {
    result = await deps.repo.append(values);
  } catch (error) {
    draft.saving = false;
    logger.error({ error }, 'Failed to write operation');
    await ctx.answerCallbackQuery({
      text: 'Не удалось записать в таблицу — попробуй ещё раз.',
      show_alert: true,
    });
    return;
  }

  deps.journal.add({
    row: result.row,
    values,
    op: draft.op,
    savedAt: new Date().toISOString(),
    messageId: ctx.callbackQuery?.message?.message_id,
  });
  deps.drafts.delete(draft.id);

  const usd = result.usd !== null ? ` · ≈ ${formatUsd(result.usd)}` : '';
  await ctx.editMessageText(
    renderCard(draft.op, ref, {
      transcript: draft.transcript,
      footer: `✅ <b>Записано</b> · строка ${result.row}${usd}`,
    }),
    { parse_mode: 'HTML', reply_markup: savedKeyboard(result.row) },
  );
  await ctx.answerCallbackQuery('Записано');
}

export function registerDraftHandlers(bot: Bot, deps: AppDeps): void {
  bot.callbackQuery(/^d:([0-9a-f]+):([a-z]+)(?::(-?\w+))?$/, async (ctx) => {
    const [, id = '', action = '', arg] = ctx.match as RegExpMatchArray;

    const draft = deps.drafts.get(id);
    if (!draft) {
      await ctx.answerCallbackQuery({
        text: 'Черновик устарел — отправь операцию заново.',
        show_alert: true,
      });
      return;
    }

    const ref = await deps.refs.get();

    if (action === 'save') {
      await saveDraft(ctx, deps, draft, ref);
      return;
    }
    if (action === 'cancel') {
      deps.drafts.delete(draft.id);
      await ctx.editMessageText('❌ Отменено');
      await ctx.answerCallbackQuery();
      return;
    }

    const notice = applyAction(draft, ref, action, arg, deps.env.BOT_TIMEZONE);
    const { text, keyboard } = renderDraft(draft, ref);
    await ignoreNotModified(
      ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }),
    );
    await ctx.answerCallbackQuery(notice ?? undefined);
  });
}

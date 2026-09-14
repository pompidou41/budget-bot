import type { Bot, Context } from 'grammy';
import { buildReviewSignals, type ReviewScope } from '../../analytics/signals.js';
import { todayIn } from '../../domain/dates.js';
import { escapeHtml } from '../../domain/format.js';
import { renderReviewHtml, renderReviewRich, REVIEW_PREFIX } from '../../domain/review.js';
import { logger } from '../../logger.js';
import type { AppDeps } from '../deps.js';
import { reviewKeyboard } from '../keyboards.js';
import { editView } from '../rich.js';
import { describeError, inBackground } from '../telegram.js';

/** `/review`, `/review месяц`, `/review этот месяц` → which period to look at. */
export function parseReviewScope(text: string): ReviewScope {
  const words = text.trim().toLowerCase();
  // «этот месяц» also contains «мес», so the month in progress is checked first
  if (/(этот|текущ|сейчас|пока|mtd)/.test(words)) return 'mtd';
  if (/(мес|month)/.test(words)) return 'month';
  return 'week';
}

async function runReview(ctx: Context, deps: AppDeps, scope: ReviewScope): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  // A button press starts a new review below the old one; only a typed command gets a reply
  const replyTo = ctx.callbackQuery ? undefined : ctx.msg?.message_id;
  await ctx.replyWithChatAction('typing');
  const placeholder = await ctx.reply('⏳ Разбираю траты и думаю над выводами — это до минуты…', {
    reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
  });

  try {
    const [ref, txns] = await Promise.all([deps.refs.get(), deps.data.get()]);
    const signals = buildReviewSignals(txns, ref, todayIn(deps.env.BOT_TIMEZONE), scope);

    if (signals.txnCount === 0 && signals.oneOff === 0) {
      await ctx.api.editMessageText(
        chatId,
        placeholder.message_id,
        `За ${signals.window.title} трат нет — разбирать пока нечего.`,
        { reply_markup: reviewKeyboard(scope) },
      );
      return;
    }

    const review = await deps.analyst.review({
      signals,
      ref,
      txns,
      notes: deps.settings.get().notes,
    });

    await editView(
      ctx.api,
      chatId,
      placeholder.message_id,
      {
        rich: renderReviewRich(review, signals),
        html: renderReviewHtml(review, signals),
        keyboard: reviewKeyboard(scope),
      },
      deps.env.RENDER_MODE,
    );

    // A reply to the review continues as an /ask thread that already knows what was said
    deps.conversations.remember(chatId, placeholder.message_id, [
      { role: 'user', content: `Сделай разбор: ${signals.window.title}.` },
      {
        role: 'assistant',
        content: JSON.stringify({
          action: 'answer',
          headline: review.headline,
          sections: [
            {
              title: 'Разбор',
              bullets: [
                review.story,
                ...review.insights.map((i) => `${i.title}: ${i.text}`),
                ...review.actions.map((a) => `${a.action} — ${a.why}`),
              ],
            },
          ],
          seriesTitle: '',
          seriesUnit: '$',
          series: [],
          note: review.explain,
        }),
      },
    ]);
  } catch (error) {
    logger.error({ error, scope }, 'Failed to build a review');
    await ctx.api.editMessageText(
      chatId,
      placeholder.message_id,
      `⚠️ Не получилось сделать разбор: ${escapeHtml(describeError(error))}`,
      { parse_mode: 'HTML', reply_markup: reviewKeyboard(scope) },
    );
  }
}

export function registerReview(bot: Bot, deps: AppDeps): void {
  bot.command('review', (ctx) => {
    inBackground(runReview(ctx, deps, parseReviewScope(ctx.match)), 'review');
  });

  bot.callbackQuery(new RegExp(`^${REVIEW_PREFIX}(week|month|mtd)$`), async (ctx) => {
    const scope = (ctx.match as RegExpMatchArray)[1] as ReviewScope;
    await ctx.answerCallbackQuery({ text: 'Готовлю разбор…' });
    inBackground(runReview(ctx, deps, scope), 'review');
  });
}

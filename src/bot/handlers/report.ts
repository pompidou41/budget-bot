import type { Bot, Context } from 'grammy';
import { lastClosedBucket } from '../../analytics/buckets.js';
import { todayIn } from '../../domain/dates.js';
import { buildHeatmap } from '../../domain/heatmap.js';
import {
  buildReportData,
  categoryNames,
  decodeReport,
  DEFAULT_REPORT,
  renderReportHtml,
  renderReportRich,
  REPORT_IMAGE_PREFIX,
  REPORT_PREFIX,
  type ReportData,
  type ReportState,
} from '../../domain/report.js';
import { renderHeatmapSvg } from '../../render/heatmap-svg.js';
import { svgToPng } from '../../render/png.js';
import type { AppDeps } from '../deps.js';
import { photoKeyboard, reportKeyboard } from '../keyboards.js';
import { editPhotoView, sendPhotoView } from '../photo.js';
import { sendRecap } from '../recap.js';
import { editView, sendView, type RichView } from '../rich.js';

const NO_SPENDING = 'За выбранный период трат нет.';

function view(state: ReportState, data: ReportData): RichView {
  return {
    rich: renderReportRich(state, data),
    html: renderReportHtml(state, data),
    keyboard: reportKeyboard(state, data.allCategories),
  };
}

/**
 * Shows a screen: redraws message `messageId` in place, or, with none, sends a new message that
 * replies to `replyTo` (the command's own message unless told otherwise).
 */
async function screen(
  ctx: Context,
  deps: AppDeps,
  state: ReportState,
  messageId?: number,
  replyTo = ctx.msg?.message_id,
) {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const [ref, txns] = await Promise.all([deps.refs.get(), deps.data.get()]);
  const today = todayIn(deps.env.BOT_TIMEZONE);
  const rendered = view(state, buildReportData(txns, ref, today, state));

  if (messageId === undefined) {
    await sendView(ctx.api, chatId, rendered, deps.env.RENDER_MODE, replyTo);
    return;
  }
  await editView(ctx.api, chatId, messageId, rendered, deps.env.RENDER_MODE);
}

export function registerReport(bot: Bot, deps: AppDeps): void {
  bot.command('report', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    await screen(ctx, deps, DEFAULT_REPORT);
  });

  // The last closed week on demand; it neither waits for the schedule nor counts as sent
  bot.command('recap', async (ctx) => {
    await ctx.replyWithChatAction('upload_photo');
    await sendRecap(ctx.api, deps, lastClosedBucket(todayIn(deps.env.BOT_TIMEZONE)));
  });

  // Every switch on the screen carries the whole state, so no session outlives a restart
  bot.callbackQuery(new RegExp(`^${REPORT_PREFIX}`), async (ctx) => {
    const ref = await deps.refs.get();
    const state = decodeReport(ctx.callbackQuery.data, categoryNames(ref));
    if (!state) {
      await ctx.answerCallbackQuery({ text: 'Не понял кнопку — набери /report заново.' });
      return;
    }

    await ctx.answerCallbackQuery();

    const message = ctx.callbackQuery.message;
    if (message && 'photo' in message && message.photo) {
      // A photo has no text to edit: from the picture the table arrives as a new message and the
      // picture stays as it is
      await screen(ctx, deps, state, undefined, message.message_id);
      return;
    }
    await screen(ctx, deps, state, message?.message_id);
  });

  // The picture of the same screen: from a table it arrives as a new photo, from a photo it
  // redraws that photo in place
  bot.callbackQuery(new RegExp(`^${REPORT_IMAGE_PREFIX}`), async (ctx) => {
    const chatId = ctx.chat?.id;
    const message = ctx.callbackQuery.message;
    const ref = await deps.refs.get();
    const state = decodeReport(ctx.callbackQuery.data, categoryNames(ref));
    if (chatId === undefined || !message || !state) {
      await ctx.answerCallbackQuery({ text: 'Не понял кнопку — набери /report заново.' });
      return;
    }

    const txns = await deps.data.get();
    const model = buildHeatmap(txns, ref, todayIn(deps.env.BOT_TIMEZONE), state);
    if (model.rows.length === 0) {
      await ctx.answerCallbackQuery({ text: NO_SPENDING });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.replyWithChatAction('upload_photo');
    const png = await svgToPng(renderHeatmapSvg(model));
    const keyboard = photoKeyboard(state, categoryNames(ref));

    if ('photo' in message && message.photo) {
      // A recap's text stays under its picture however the picture is redrawn
      await editPhotoView(ctx.api, chatId, message.message_id, {
        png,
        caption: message.caption,
        captionEntities:
          message.caption === undefined ? undefined : (message.caption_entities ?? []),
        keyboard,
      });
      return;
    }
    await sendPhotoView(ctx.api, chatId, { png, keyboard }, message.message_id);
  });
}

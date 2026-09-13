import type { Bot, Context } from 'grammy';
import type { Txn } from '../../analytics/dataset.js';
import {
  buildMatrix,
  byCategory,
  periodTotals,
  recentPeriods,
  sumUsd,
  weekKey,
} from '../../analytics/queries.js';
import { todayIn } from '../../domain/dates.js';
import type { Reference } from '../../domain/reference.js';
import {
  decodeReport,
  DEFAULT_REPORT,
  renderReportHtml,
  renderReportRich,
  REPORT_PREFIX,
  type ReportData,
  type ReportState,
} from '../../domain/report.js';
import type { AppDeps } from '../deps.js';
import { reportKeyboard } from '../keyboards.js';
import { editView, sendView, type RichView } from '../rich.js';

function categoryNames(ref: Reference): string[] {
  return ref.categories.map((category) => category.name);
}

/** Everything the screen shows, computed here so the model is never in this path. */
function buildReportData(
  txns: Txn[],
  ref: Reference,
  today: string,
  state: ReportState,
): ReportData {
  const periods = recentPeriods(today, state.period, state.count);
  const window = new Set(periods);
  const selected = new Set(state.categories);

  const include = (txn: Txn): boolean =>
    txn.type === 'Расход' &&
    (state.oneOff || !txn.oneOff) &&
    (selected.size === 0 || selected.has(txn.category));

  const rows = byCategory(buildMatrix(txns, periods, include, state.period)).filter(
    (row) => row.total > 0,
  );

  const oneOffTotal = sumUsd(
    txns.filter(
      (txn) =>
        txn.type === 'Расход' &&
        txn.oneOff &&
        window.has(state.period === 'week' ? weekKey(txn.date) : txn.month) &&
        (selected.size === 0 || selected.has(txn.category)),
    ),
  );

  return {
    rows,
    totals: periodTotals(txns, periods, include, state.period),
    periods,
    allCategories: categoryNames(ref),
    oneOffTotal,
  };
}

function view(state: ReportState, data: ReportData): RichView {
  return {
    rich: renderReportRich(state, data),
    html: renderReportHtml(state, data),
    keyboard: reportKeyboard(state, data.allCategories),
  };
}

async function screen(ctx: Context, deps: AppDeps, state: ReportState, messageId?: number) {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const [ref, txns] = await Promise.all([deps.refs.get(), deps.data.get()]);
  const today = todayIn(deps.env.BOT_TIMEZONE);
  const rendered = view(state, buildReportData(txns, ref, today, state));

  if (messageId === undefined) {
    await sendView(ctx.api, chatId, rendered, deps.env.RENDER_MODE, ctx.msg?.message_id);
    return;
  }
  await editView(ctx.api, chatId, messageId, rendered, deps.env.RENDER_MODE);
}

export function registerReport(bot: Bot, deps: AppDeps): void {
  bot.command('report', async (ctx) => {
    await ctx.replyWithChatAction('typing');
    await screen(ctx, deps, DEFAULT_REPORT);
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
    await screen(ctx, deps, state, ctx.callbackQuery.message?.message_id);
  });
}

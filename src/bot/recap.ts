import type { Api } from 'grammy';
import { recapCaption, summarizeBucket } from '../analytics/buckets.js';
import { todayIn } from '../domain/dates.js';
import { buildHeatmap } from '../domain/heatmap.js';
import { categoryNames, type ReportState } from '../domain/report.js';
import { renderHeatmapSvg } from '../render/heatmap-svg.js';
import { svgToPng } from '../render/png.js';
import type { AppDeps } from './deps.js';
import { photoKeyboard } from './keyboards.js';
import { sendPhotoView } from './photo.js';

/**
 * What a recap shows and compares in: the two months of buckets the owner's old sheet drew,
 * in rubles, without one-offs. Pinned here rather than taken from `DEFAULT_REPORT`, so a
 * change to the `/report` default cannot quietly change what the recap says.
 */
const RECAP_REPORT: ReportState = {
  period: 'bucket',
  count: 8,
  categories: [],
  oneOff: false,
  currency: 'RUB',
};

/**
 * Sends the owner the recap of a closed bucket: the heatmap with that bucket outlined, a few
 * lines of caption, and the picture's own buttons. Reads the sheet afresh — the numbers of a
 * recap must not be ten minutes stale. Resolves to the id of the message it sent.
 */
export async function sendRecap(api: Api, deps: AppDeps, key: string): Promise<number> {
  const [ref, txns] = await Promise.all([deps.refs.get(), deps.data.reload()]);
  const today = todayIn(deps.env.BOT_TIMEZONE);

  const summary = summarizeBucket(txns, key, { money: 'rub', oneOff: RECAP_REPORT.oneOff });
  const model = buildHeatmap(txns, ref, today, RECAP_REPORT, key);

  return sendPhotoView(api, deps.env.OWNER_TELEGRAM_ID, {
    png: await svgToPng(renderHeatmapSvg(model)),
    caption: recapCaption(summary, RECAP_REPORT.currency),
    keyboard: photoKeyboard(RECAP_REPORT, categoryNames(ref)),
  });
}

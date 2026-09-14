import type { ReviewScope, ReviewSignals } from '../analytics/signals.js';
import { renderBars } from './bars.js';
import { escapeHtml, escapeRich, formatUsd } from './format.js';

export type InsightTone = 'good' | 'watch' | 'alert' | 'info';

export interface ReviewInsight {
  tone: InsightTone;
  title: string;
  text: string;
}

export interface ReviewAction {
  action: string;
  why: string;
  /** Expected effect in plain words, e.g. «~$200 в месяц», or empty. */
  effect: string;
}

/**
 * A review as data. Like `Answer`, the model fills it in and the bot renders it: every figure
 * in the tables comes from our own signals, and the model contributes only the explanation.
 */
export interface Review {
  /** The main conclusion in one plain sentence. */
  headline: string;
  /** Two to four sentences: what happened and why. */
  story: string;
  insights: ReviewInsight[];
  actions: ReviewAction[];
  /** One term explained simply, when the review leans on it; empty otherwise. */
  explain: string;
  /** A question worth asking next; empty otherwise. */
  followUp: string;
}

export const REVIEW_PREFIX = 'v:';

export const REVIEW_SCOPES: { scope: ReviewScope; label: string }[] = [
  { scope: 'week', label: 'Прошлая неделя' },
  { scope: 'month', label: 'Прошлый месяц' },
  { scope: 'mtd', label: 'Этот месяц' },
];

const TONE_MARK: Record<InsightTone, string> = {
  good: '✅',
  watch: '👀',
  alert: '⚠️',
  info: 'ℹ️',
};

const MAX_CATEGORY_ROWS = 10;
// Telegram rejects ordinary messages over 4096 characters
const MAX_HTML_LENGTH = 3900;
const CATEGORY_HEADER = ['Категория', 'Сейчас', 'Обычно', 'Разница'];

function usd(value: number): string {
  return formatUsd(Math.round(value));
}

function signedUsd(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '±$0';
  return `${rounded > 0 ? '+' : '−'}${formatUsd(Math.abs(rounded))}`;
}

function percent(value: number | null): string {
  if (value === null) return '';
  const rounded = Math.round(value * 100);
  return ` (${rounded > 0 ? '+' : ''}${rounded}%)`;
}

/** The headline figures. Always ours: the model's text may round or misquote, these may not. */
export function reviewFigures(signals: ReviewSignals): [string, string][] {
  const inProgress = signals.window.daysPassed !== undefined;
  const rows: [string, string][] = [
    ['Потрачено', usd(signals.spent)],
    [
      // The owner should know an estimate is an estimate; why is not their problem
      `${inProgress ? 'Обычно к этому дню' : 'Обычно за такой период'}${signals.approximate ? ' (примерно)' : ''}`,
      usd(signals.typical),
    ],
    ['Разница', `${signedUsd(signals.delta)}${percent(signals.deltaPct)}`],
  ];
  if (signals.projection) {
    rows.push([
      'Прогноз на месяц',
      `${usd(signals.projection.expected)} (обычно ${usd(signals.projection.typicalMonth)})`,
    ]);
  }
  if (signals.fixed > 0) rows.push(['Из них обязательные платежи', usd(signals.fixed)]);
  if (signals.oneOff > 0) rows.push(['Разовые покупки', usd(signals.oneOff)]);
  if (signals.income > 0) rows.push(['Доходы', usd(signals.income)]);
  if (signals.saved > 0) rows.push(['Отложено', usd(signals.saved)]);
  return rows;
}

function categoryRows(signals: ReviewSignals): string[][] {
  return signals.categories
    .slice(0, MAX_CATEGORY_ROWS)
    .map((c) => [c.category, usd(c.actual), usd(c.typical), signedUsd(c.delta)]);
}

function historyBars(signals: ReviewSignals): string {
  return renderBars(signals.history, usd);
}

// ─── rich rendering ────────────────────────────────────────────────────────────────────

function richTable(rows: string[][], header?: string[]): string {
  const cell = (tag: 'th' | 'td', text: string, column: number) =>
    `<${tag} align="${column === 0 ? 'left' : 'right'}">${escapeRich(text)}</${tag}>`;
  const head = header ? `<tr>${header.map((text, i) => cell('th', text, i)).join('')}</tr>` : '';
  const body = rows
    .map((row) => `<tr>${row.map((text, i) => cell('td', text, i)).join('')}</tr>`)
    .join('');
  return `<table striped compact>${head}${body}</table>`;
}

function richScopeButtons(current: ReviewScope): string {
  const buttons = REVIEW_SCOPES.map(({ scope, label }) =>
    scope === current
      ? `<tg-button type="disabled" style="primary">${escapeRich(label)}</tg-button>`
      : `<tg-button type="callback_data" data="${REVIEW_PREFIX}${scope}">${escapeRich(label)}</tg-button>`,
  );
  return `<tg-button-row>${buttons.join('')}</tg-button-row>`;
}

/**
 * Words first, numbers on demand: the explanation is what the owner came for, so the detailed
 * category table and the chart sit in collapsed blocks below it.
 */
export function renderReviewRich(review: Review, signals: ReviewSignals): string {
  const parts = [`<h3>📊 Разбор: ${escapeRich(signals.window.title)}</h3>`];

  if (review.headline) parts.push(`<p><b>${escapeRich(review.headline)}</b></p>`);
  parts.push(richTable(reviewFigures(signals)));
  if (review.story) parts.push(`<p>${escapeRich(review.story)}</p>`);

  if (review.insights.length > 0) {
    const items = review.insights.map(
      (i) => `<li>${TONE_MARK[i.tone]} <b>${escapeRich(i.title)}</b> — ${escapeRich(i.text)}</li>`,
    );
    parts.push('<h4>💡 Что я заметил</h4>', `<ul>${items.join('')}</ul>`);
  }

  if (review.actions.length > 0) {
    const items = review.actions.map(
      (a) =>
        `<li><b>${escapeRich(a.action)}</b> — ${escapeRich(a.why)}${a.effect ? ` <i>(${escapeRich(a.effect)})</i>` : ''}</li>`,
    );
    parts.push('<h4>🎯 Что можно сделать</h4>', `<ol>${items.join('')}</ol>`);
  }

  if (signals.categories.length > 0) {
    parts.push(
      `<details><summary>Цифры по категориям</summary>${richTable(categoryRows(signals), CATEGORY_HEADER)}</details>`,
    );
  }
  // One bar is not a trend: while real weeks are few, the chart would only show the current one
  if (signals.history.length >= 2) {
    parts.push(`<details><summary>Как менялись траты</summary>${historyBars(signals)}</details>`);
  }

  if (review.explain) parts.push(`<blockquote>📖 ${escapeRich(review.explain)}</blockquote>`);
  parts.push(
    review.followUp
      ? `<p>❓ Можно спросить дальше: <i>${escapeRich(review.followUp)}</i><br>Просто ответь на это сообщение.</p>`
      : '<p><i>Ответь на это сообщение, чтобы спросить подробнее.</i></p>',
  );
  parts.push(richScopeButtons(signals.window.scope));

  return parts.join('');
}

// ─── plain HTML fallback ───────────────────────────────────────────────────────────────

function pad(text: string, width: number, right: boolean): string {
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return right ? clipped.padStart(width) : clipped.padEnd(width);
}

function preTable(rows: string[][], header: string[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.min(Math.max(...all.map((row) => (row[column] ?? '').length)), column === 0 ? 14 : 10),
  );
  const lines = all.map((row) =>
    row.map((text, column) => pad(text, widths[column] ?? 8, column > 0)).join(' '),
  );
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

export function renderReviewHtml(review: Review, signals: ReviewSignals): string {
  const blocks = [`📊 <b>Разбор: ${escapeHtml(signals.window.title)}</b>`];

  if (review.headline) blocks.push(`<b>${escapeHtml(review.headline)}</b>`);
  blocks.push(
    reviewFigures(signals)
      .map(([label, value]) => `${escapeHtml(label)}: <b>${escapeHtml(value)}</b>`)
      .join('\n'),
  );
  if (review.story) blocks.push(escapeHtml(review.story));

  if (review.insights.length > 0) {
    blocks.push(
      [
        '💡 <b>Что я заметил</b>',
        ...review.insights.map(
          (i) => `${TONE_MARK[i.tone]} <b>${escapeHtml(i.title)}</b> — ${escapeHtml(i.text)}`,
        ),
      ].join('\n'),
    );
  }

  if (review.actions.length > 0) {
    blocks.push(
      [
        '🎯 <b>Что можно сделать</b>',
        ...review.actions.map(
          (a, n) =>
            `${n + 1}. <b>${escapeHtml(a.action)}</b> — ${escapeHtml(a.why)}${a.effect ? ` <i>(${escapeHtml(a.effect)})</i>` : ''}`,
        ),
      ].join('\n'),
    );
  }

  if (review.explain) blocks.push(`📖 <i>${escapeHtml(review.explain)}</i>`);
  if (signals.categories.length > 0) blocks.push(preTable(categoryRows(signals), CATEGORY_HEADER));
  if (signals.history.length >= 2) blocks.push(historyBars(signals));
  blocks.push(
    review.followUp
      ? `❓ Можно спросить дальше: <i>${escapeHtml(review.followUp)}</i> — просто ответь на это сообщение.`
      : '<i>Ответь на это сообщение, чтобы спросить подробнее.</i>',
  );

  // Drop whole trailing blocks rather than cutting mid-tag; the words come before the tables
  const kept: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (length + block.length + 2 > MAX_HTML_LENGTH) break;
    kept.push(block);
    length += block.length + 2;
  }
  return kept.join('\n\n');
}

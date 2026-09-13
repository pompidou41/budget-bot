import { renderBars, type BarPoint } from './bars.js';
import { escapeHtml, escapeRich, formatAmount, formatUsd } from './format.js';

export interface AnswerSection {
  title: string;
  bullets: string[];
}

export interface AnswerPoint {
  label: string;
  value: number;
}

/**
 * A finance answer as data, never as markup. The model fills this in; the bot renders it,
 * so a malformed tag from the model cannot reach Telegram.
 */
export interface Answer {
  headline: string;
  sections: AnswerSection[];
  seriesTitle: string;
  seriesUnit: string;
  series: AnswerPoint[];
  note: string;
}

// Telegram rejects messages over 4096 characters
const MAX_LENGTH = 3900;

function formatValue(value: number, unit: string): string {
  const clean = unit.trim();
  if (clean === '' || clean === '$' || clean.toUpperCase() === 'USD') return formatUsd(value);
  if (clean === '%') return `${formatAmount(Math.round(value * 10) / 10)}%`;
  return `${formatAmount(Math.round(value * 100) / 100)} ${clean}`;
}

/** The dynamics the model describes, drawn from numbers we own. */
function renderSeries(series: AnswerPoint[], unit: string): string {
  return renderBars(series as BarPoint[], (value) => formatValue(value, unit));
}

export function renderAnswer(answer: Answer): string {
  const blocks: string[] = [];

  if (answer.headline.trim()) blocks.push(`🧠 <b>${escapeHtml(answer.headline)}</b>`);

  for (const section of answer.sections) {
    const bullets = section.bullets
      .filter((bullet) => bullet.trim())
      .map((bullet) => `• ${escapeHtml(bullet)}`);
    if (bullets.length === 0 && !section.title.trim()) continue;

    const title = section.title.trim() ? `<b>${escapeHtml(section.title)}</b>` : '';
    blocks.push([title, ...bullets].filter(Boolean).join('\n'));
  }

  if (answer.series.length > 0) {
    const title = answer.seriesTitle.trim() ? `<b>${escapeHtml(answer.seriesTitle)}</b>\n` : '';
    blocks.push(title + renderSeries(answer.series, answer.seriesUnit));
  }

  if (answer.note.trim()) blocks.push(`<i>${escapeHtml(answer.note)}</i>`);

  // Drop whole blocks rather than cutting mid-tag, which would break HTML parsing
  const kept: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (length + block.length + 2 > MAX_LENGTH) {
      kept.push('<i>…ответ сокращён, спроси про конкретный кусок.</i>');
      break;
    }
    kept.push(block);
    length += block.length + 2;
  }

  return kept.join('\n\n') || '🤷 Не нашёл, что ответить — переформулируй вопрос.';
}

/**
 * The same answer as a rich message: real headings and lists instead of bold lines, and the
 * series as a table beside its bars. Rich messages hold far more than 4096 characters, so
 * nothing is dropped here — the block-level truncation above exists only for the fallback.
 */
export function renderAnswerRich(answer: Answer): string {
  const blocks: string[] = [];

  if (answer.headline.trim()) blocks.push(`<h3>🧠 ${escapeRich(answer.headline)}</h3>`);

  for (const section of answer.sections) {
    const bullets = section.bullets.filter((bullet) => bullet.trim());
    if (bullets.length === 0 && !section.title.trim()) continue;

    if (section.title.trim()) blocks.push(`<h4>${escapeRich(section.title)}</h4>`);
    if (bullets.length > 0) {
      blocks.push(`<ul>${bullets.map((b) => `<li>${escapeRich(b)}</li>`).join('')}</ul>`);
    }
  }

  if (answer.series.length > 0) {
    if (answer.seriesTitle.trim()) blocks.push(`<h4>${escapeRich(answer.seriesTitle)}</h4>`);
    blocks.push(renderSeriesRich(answer.series, answer.seriesUnit));
  }

  if (answer.note.trim()) blocks.push(`<footer>${escapeRich(answer.note)}</footer>`);

  return (
    blocks.join('') || `<p>${escapeRich('🤷 Не нашёл, что ответить — переформулируй вопрос.')}</p>`
  );
}

/** Value, bar and figure in one row: the shape is visible without losing the exact number. */
function renderSeriesRich(series: AnswerPoint[], unit: string): string {
  const peak = Math.max(...series.map((point) => Math.abs(point.value)), 0);
  const rows = series.map((point) => {
    const filled = peak > 0 ? Math.round((Math.abs(point.value) / peak) * RICH_BAR_WIDTH) : 0;
    const bar = '█'.repeat(Math.max(filled, point.value === 0 ? 0 : 1));
    return [
      `<td align="left">${escapeRich(point.label)}</td>`,
      `<td align="left">${bar}</td>`,
      `<td align="right">${escapeRich(formatValue(point.value, unit))}</td>`,
    ].join('');
  });

  return `<table compact>${rows.map((row) => `<tr>${row}</tr>`).join('')}</table>`;
}

const RICH_BAR_WIDTH = 10;

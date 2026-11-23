import type { CapitalLine, CapitalSnapshot } from '../sheets/capital-read.js';
import { escapeHtml, formatAmount } from './format.js';

/** Whole units with the currency mark; the sheet already did all the arithmetic. */
export function whole(amount: number, currency: string): string {
  const rounded = Math.round(Math.abs(amount));
  const sign = amount < 0 && rounded > 0 ? '−' : '';
  const body = formatAmount(rounded);
  if (currency === 'USD') return `${sign}$${body}`;
  return `${sign}${body}\u00a0${currency === 'RUB' ? '₽' : currency}`;
}

export type Tone = 'up' | 'down' | 'flat';

export function toneOf(amount: number | null): Tone {
  if (amount === null || Math.round(amount) === 0) return 'flat';
  return amount > 0 ? 'up' : 'down';
}

/** `▼ $1 489`, or `0` when the change rounds to nothing. */
export function delta(amount: number | null, currency: string): string {
  if (amount === null) return '';
  const rounded = Math.round(Math.abs(amount));
  if (rounded === 0) return '0';
  return `${amount > 0 ? '▲' : '▼'} ${whole(rounded, currency)}`;
}

export function pctText(pct: number): string {
  const value = Math.abs(pct * 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${pct < 0 ? '−' : '+'}${value}%`;
}

/** `▼ $1 489 (−8,2%)`; the label, if any, goes between the amount and the percentage. */
export function withPct(amount: number, pct: number | null, currency: string, label = ''): string {
  const base = [delta(amount, currency), label].filter(Boolean).join(' ');
  if (pct === null || Math.round(amount) === 0) return base;
  return `${base} (${pctText(pct)})`;
}

export const lowerFirst = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

const LINES: { title: string; pick: (s: CapitalSnapshot) => CapitalLine }[] = [
  { title: 'Капитал', pick: (s) => s.capital },
  { title: 'Сбережения', pick: (s) => s.savings },
];

/** Text version: the summary and the groups, no points. Also the fallback when drawing fails. */
export function renderCapital(s: CapitalSnapshot): string {
  const c = s.currency;
  const lines = [`<b>💼 Капитал и сбережения · ${escapeHtml(c)}</b>`];
  for (const { title, pick } of LINES) {
    const line = pick(s);
    lines.push(
      '',
      `<b>${title}:</b> ${whole(line.now, c)}`,
      `${escapeHtml(lowerFirst(s.monthLabel))}: ${withPct(line.monthDelta, line.monthPct, c)}`,
      `${escapeHtml(lowerFirst(s.startLabel))}: ${withPct(line.startDelta, line.startPct, c)}`,
    );
  }
  const groups = s.groups.filter((g) => g.value !== 0);
  if (groups.length > 0) {
    lines.push('', '<b>Сейчас по группам</b>');
    for (const g of groups) lines.push(`• ${escapeHtml(g.name)}: ${whole(g.value, c)}`);
  }
  if (s.note) lines.push('', `<i>${escapeHtml(s.note)}</i>`);
  return lines.join('\n');
}

/** Two short lines under the picture (Telegram HTML). */
export function renderCapitalCaption(s: CapitalSnapshot): string {
  const c = s.currency;
  const { capital, savings } = s;
  return [
    `💼 <b>Капитал ${whole(capital.now, c)}</b> · ${withPct(capital.monthDelta, capital.monthPct, c, 'за месяц')}`,
    `Сбережения ${whole(savings.now, c)} · ${withPct(savings.monthDelta, savings.monthPct, c)}`,
  ].join('\n');
}

export const CAPITAL_MISSING =
  'Листа «Капитал» ещё нет в таблице. Создай его командой <code>yarn capital-sheet</code>.';

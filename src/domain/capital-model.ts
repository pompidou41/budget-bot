import type { CapitalLine, CapitalSnapshot } from '../sheets/capital-read.js';
import { lowerFirst, pctText, toneOf, whole, type Tone } from './capital.js';
import { formatAmount } from './format.js';

/** More points than this make the line a scribble on a phone; only the latest are drawn. */
export const MAX_POINTS = 26;
const TARGET_TICKS = 4;
const GROUP_MIN = 0.5;
const NOTE_WIDTH = 50;

export interface HeaderLine {
  label: string;
  text: string;
  tone: Tone;
}

export interface HeaderBlock {
  title: string;
  value: string;
  lines: HeaderLine[];
}

export interface ChartPoint {
  label: string;
  capital: number;
  savings: number;
}

export interface GroupBar {
  name: string;
  value: number;
  text: string;
}

export interface CapitalModel {
  currency: string;
  blocks: HeaderBlock[];
  points: ChartPoint[];
  /** Ascending axis values; the first and the last are the axis ends. */
  ticks: number[];
  tickLabels: string[];
  lastLabels: { capital: string; savings: string };
  groups: GroupBar[];
  notes: string[];
}

const STEPS = [1, 2, 2.5, 5, 10];

/** Round values spanning the data with a little air; the axis does not start at zero. */
export function niceTicks(min: number, max: number): number[] {
  const span = max - min;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(max) * 0.05, 1);
  const lo = min - pad;
  const hi = max + pad;
  const raw = (hi - lo) / TARGET_TICKS;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => s * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; ; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
    if (v >= hi - 1e-9) break;
  }
  return ticks;
}

const compactNumber = (value: number) =>
  formatAmount(Math.round(value * 100) / 100).replace(/[\u202f\u00a0]/g, ' ');

/** `$16k`, `1,2 млн ₽`, `850 тыс ₽`: short enough for an axis. */
export function axisLabel(value: number, currency: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const usd = currency === 'USD';
  const mark = currency === 'RUB' ? '₽' : currency;
  const wrapMark = (body: string) => (usd ? `${sign}$${body}` : `${sign}${body} ${mark}`);
  if (abs >= 1e6) return wrapMark(`${compactNumber(abs / 1e6)}${usd ? 'M' : ' млн'}`);
  if (abs >= 1000) return wrapMark(`${compactNumber(abs / 1000)}${usd ? 'k' : ' тыс'}`);
  return wrapMark(compactNumber(abs));
}

function changeLine(amount: number, pct: number | null, label: string, c: string): HeaderLine {
  const rounded = Math.round(Math.abs(amount));
  if (rounded === 0) return { label, text: 'без изменений', tone: 'flat' };
  const pctPart = pct === null ? '' : ` · ${pctText(pct)}`;
  const arrow = amount > 0 ? '▲' : '▼';
  return { label, text: `${arrow} ${whole(rounded, c)}${pctPart}`, tone: toneOf(amount) };
}

function block(title: string, line: CapitalLine, s: CapitalSnapshot): HeaderBlock {
  const c = s.currency;
  return {
    title,
    value: whole(line.now, c),
    lines: [
      changeLine(line.monthDelta, line.monthPct, 'за месяц', c),
      changeLine(line.startDelta, line.startPct, lowerFirst(s.startLabel), c),
    ],
  };
}

/** Wraps a note into lines of at most `max` characters, on spaces. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + word.length + 1 > max) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

function groupBars(s: CapitalSnapshot): GroupBar[] {
  const total = s.capital.now;
  return s.groups
    .filter((g) => Math.abs(g.value) >= GROUP_MIN)
    .sort((a, b) => b.value - a.value)
    .map((g) => {
      const share = total > 0 ? Math.round((Math.abs(g.value) / total) * 100) : null;
      const pct = share === null ? '' : ` · ${share === 0 ? '<1' : share}%`;
      return { name: g.name, value: g.value, text: `${whole(g.value, s.currency)}${pct}` };
    });
}

export function buildCapitalModel(s: CapitalSnapshot): CapitalModel {
  const c = s.currency;
  const cut = s.points.length > MAX_POINTS;
  const points = s.points.slice(-MAX_POINTS).map((p) => ({
    label: p.label,
    capital: p.capital,
    savings: p.savings,
  }));
  const values = points.flatMap((p) => [p.capital, p.savings]);
  const ticks = values.length > 0 ? niceTicks(Math.min(...values), Math.max(...values)) : [0, 1];
  const last = points[points.length - 1];
  return {
    currency: c,
    blocks: [block('Капитал', s.capital, s), block('Сбережения', s.savings, s)],
    points,
    ticks,
    tickLabels: ticks.map((t) => axisLabel(t, c)),
    lastLabels: {
      capital: whole(last?.capital ?? s.capital.now, c),
      savings: whole(last?.savings ?? s.savings.now, c),
    },
    groups: groupBars(s),
    notes: [...wrap(s.note, NOTE_WIDTH), ...(cut ? [`последние ${MAX_POINTS} срезов`] : [])],
  };
}

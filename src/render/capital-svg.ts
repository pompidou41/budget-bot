import type { CapitalModel, GroupBar, HeaderBlock } from '../domain/capital-model.js';
import { escapeXml, num } from './heatmap-svg.js';

// Everything is in SVG user units; the PNG step magnifies the whole picture by a fixed zoom.
// A phone shows the photo about 330pt wide, so ~680 units: text under 20 units would be unreadable.
const W = 680;
const PAD = 20;
const CHART_LEFT = PAD + 92;
const CHART_RIGHT = W - PAD - 110;
const HEAD_TOP = 8;
const RIGHT_COL_X = 350;
const LEGEND_Y = 276;
const PLOT_TOP = LEGEND_Y + 24;
const PLOT_H = 300;
const MIN_LABEL_GAP = 64;
const BAR_H = 26;
const ROW_H = 44;
const NOTE_LINE_H = 26;

const INK = '#1f2328';
const MUTED = '#6b7280';
const RULE = '#d4d4cf';
const UP = '#1a7f37';
const DOWN = '#cf222e';
const CAPITAL_COLOR = '#0b5cad';
const SAVINGS_COLOR = '#2a9d8f';
const TONE_COLOR = { up: UP, down: DOWN, flat: MUTED } as const;

interface TextOptions {
  size: number;
  fill?: string;
  weight?: 400 | 600;
  anchor?: 'start' | 'middle' | 'end';
}

/** One line of text with its baseline at `y`; Inter has no narrow no-break space, so spaces are plain. */
function text(content: string, x: number, y: number, options: TextOptions): string {
  const { size, fill = INK, weight = 400, anchor = 'start' } = options;
  const plain = content.replace(/[\u202f\u00a0\u2009]/g, ' ');
  const attrs = `x="${num(x)}" y="${num(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}"`;
  return `<text ${attrs} text-anchor="${anchor}">${escapeXml(plain)}</text>`;
}

function headerBlock(b: HeaderBlock, x: number, valueSize: number): string[] {
  const out = [
    text(b.title, x, HEAD_TOP + 24, { size: 20, fill: MUTED }),
    text(b.value, x, HEAD_TOP + 84, { size: valueSize, weight: 600 }),
  ];
  b.lines.forEach((line, i) => {
    const y = HEAD_TOP + 120 + i * 64;
    out.push(
      text(line.label, x, y, { size: 20, fill: MUTED }),
      text(line.text, x, y + 28, {
        size: 24,
        fill: line.tone === 'flat' ? MUTED : TONE_COLOR[line.tone],
      }),
    );
  });
  return out;
}

/** Indices of the x labels, counted back from the last point so «сейчас» always shows; the first too. */
export function labelIndices(count: number, spacing: number): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(MIN_LABEL_GAP / Math.max(spacing, 1)));
  const shown: number[] = [];
  for (let i = count - 1; i >= 0; i -= step) shown.unshift(i);
  if (shown[0] !== 0) {
    // The first label must not crowd the next one
    if (shown.length > 1 && shown[0]! * spacing < MIN_LABEL_GAP) shown.shift();
    shown.unshift(0);
  }
  return shown;
}

/** Keeps two end labels apart: pushed symmetrically when closer than `gap`. */
function nudge(a: number, b: number, gap: number): [number, number] {
  if (Math.abs(a - b) >= gap) return [a, b];
  const mid = (a + b) / 2;
  return a <= b ? [mid - gap / 2, mid + gap / 2] : [mid + gap / 2, mid - gap / 2];
}

interface Scale {
  x: (i: number) => number;
  y: (v: number) => number;
  spacing: number;
}

function scales(m: CapitalModel): Scale {
  const n = m.points.length;
  const lo = m.ticks[0] ?? 0;
  const hi = m.ticks[m.ticks.length - 1] ?? 1;
  const span = hi - lo || 1;
  const width = CHART_RIGHT - CHART_LEFT;
  const spacing = n > 1 ? width / (n - 1) : width;
  return {
    x: (i) => (n > 1 ? CHART_LEFT + i * spacing : CHART_LEFT + width / 2),
    y: (v) => PLOT_TOP + PLOT_H - ((v - lo) / span) * PLOT_H,
    spacing,
  };
}

function grid(m: CapitalModel, sc: Scale): string[] {
  const out: string[] = [];
  m.ticks.forEach((tick, i) => {
    const y = sc.y(tick);
    out.push(
      `<line x1="${CHART_LEFT}" y1="${num(y)}" x2="${CHART_RIGHT}" y2="${num(y)}" stroke="${RULE}" stroke-width="1"/>`,
      text(m.tickLabels[i] ?? '', CHART_LEFT - 10, y + 7, { size: 20, fill: MUTED, anchor: 'end' }),
    );
  });
  return out;
}

function xLabels(m: CapitalModel, sc: Scale): string[] {
  const base = PLOT_TOP + PLOT_H + 32;
  return labelIndices(m.points.length, sc.spacing).map((i) =>
    text((m.points[i]?.label ?? '').replace(/^(\d{2}\.\d{2})\.\d{2,4}$/, '$1'), sc.x(i), base, {
      size: 20,
      fill: MUTED,
      anchor: 'middle',
    }),
  );
}

function series(m: CapitalModel, sc: Scale, pick: 'capital' | 'savings'): string[] {
  const color = pick === 'capital' ? CAPITAL_COLOR : SAVINGS_COLOR;
  const width = pick === 'capital' ? 3 : 2.5;
  const dot = m.points.length > 20 ? 2.2 : pick === 'capital' ? 3.5 : 3;
  const coords = m.points.map((p, i) => `${num(sc.x(i))},${num(sc.y(p[pick]))}`);
  const out =
    coords.length > 1
      ? [
          `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`,
        ]
      : [];
  m.points.forEach((p, i) => {
    out.push(
      `<circle cx="${num(sc.x(i))}" cy="${num(sc.y(p[pick]))}" r="${dot}" fill="${color}"/>`,
    );
  });
  return out;
}

function legend(): string[] {
  const y = LEGEND_Y;
  const item = (x: number, color: string, label: string) => [
    `<line x1="${x}" y1="${y - 5}" x2="${x + 24}" y2="${y - 5}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`,
    text(label, x + 32, y, { size: 20, fill: MUTED }),
  ];
  return [
    ...item(CHART_LEFT, CAPITAL_COLOR, 'Капитал'),
    ...item(CHART_LEFT + 170, SAVINGS_COLOR, 'Сбережения'),
  ];
}

function chart(m: CapitalModel): string[] {
  const sc = scales(m);
  const last = m.points.length - 1;
  const out = [...legend(), ...grid(m, sc), ...xLabels(m, sc)];
  out.push(...series(m, sc, 'savings'), ...series(m, sc, 'capital'));
  const point = m.points[last];
  if (point) {
    const [capY, savY] = nudge(sc.y(point.capital), sc.y(point.savings), 28);
    const x = sc.x(last) + 12;
    out.push(
      text(m.lastLabels.capital, x, capY + 7, { size: 22, weight: 600, fill: CAPITAL_COLOR }),
      text(m.lastLabels.savings, x, savY + 7, { size: 22, weight: 600, fill: SAVINGS_COLOR }),
    );
  }
  return out;
}

/** Group bars; returns the markup and the y where the section ends. */
function groupsSection(groups: GroupBar[], top: number): { parts: string[]; end: number } {
  if (groups.length === 0) return { parts: [], end: top };
  const barX = PAD + 156;
  const barMax = 290;
  const max = Math.max(...groups.map((g) => Math.abs(g.value)));
  const parts = [text('Сейчас по группам', PAD, top + 28, { size: 28, weight: 600 })];
  groups.forEach((g, i) => {
    const y = top + 56 + i * ROW_H;
    const len = Math.max(4, (Math.abs(g.value) / max) * barMax);
    const color = g.value < 0 ? DOWN : CAPITAL_COLOR;
    parts.push(
      text(g.name, PAD, y + 21, { size: 24 }),
      `<rect x="${barX}" y="${y}" width="${num(len)}" height="${BAR_H}" rx="4" fill="${color}" opacity="0.85"/>`,
      text(g.text, barX + len + 10, y + 21, { size: 24, fill: g.value < 0 ? DOWN : INK }),
    );
  });
  return { parts, end: top + 56 + groups.length * ROW_H };
}

export function renderCapitalSvg(m: CapitalModel): string {
  const [first, second] = m.blocks;
  const body: string[] = [];
  if (first) body.push(...headerBlock(first, PAD, 56));
  if (second) body.push(...headerBlock(second, RIGHT_COL_X, 48));
  body.push(...chart(m));

  const chartEnd = PLOT_TOP + PLOT_H + 32;
  const groups = groupsSection(m.groups, chartEnd + 40);
  body.push(...groups.parts);
  let y = groups.end + 30;
  for (const note of m.notes) {
    body.push(text(note, PAD, y, { size: 20, fill: MUTED }));
    y += NOTE_LINE_H;
  }
  const height = y + PAD - NOTE_LINE_H + 8;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${num(height)}" viewBox="0 0 ${W} ${num(height)}" font-family="Inter">`,
    `<rect width="${W}" height="${num(height)}" fill="#ffffff"/>`,
    ...body,
    '</svg>',
  ].join('');
}

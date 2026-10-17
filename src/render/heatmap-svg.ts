import type { HeatmapModel, HeatmapRow } from '../domain/heatmap.js';
import type { MoneyCurrency } from '../domain/format.js';

// Everything is in SVG user units; the PNG step magnifies the whole picture by a fixed zoom.
const PAD = 28;
const LABEL_W = 152;
const SUM_W = 88;
// Columns are spaced wider than rows so the outline of a column fits between its neighbours
const COL_GAP = 8;
const ROW_GAP = 3;
const ROW_H = 40;
const HEAD_H = 28;
const MONTH_H = 28;
const TITLE_SIZE = 24;
const LABEL_SIZE = 18;
const LEGEND_SIZE = 15;
const TARGET_W = 920;
const MIN_W = 600;
const MIN_CELL_W = 46;
const MAX_CELL_W = 76;
// Inter's average Cyrillic letter is about this wide, in ems; only used to keep a title inside
const TITLE_EM = 0.6;
const MAX_LABEL_CHARS = 14;

const INK = '#1f2328';
const MUTED = '#6b7280';
const BLANK = '#f6f6f3';
const SUM_FILL = '#ecece8';
const RULE = '#d4d4cf';

type Rgb = [number, number, number];

// Pale peach through orange to a deep brick: dark enough at the top that white text reads on it
const HEAT_STOPS: { at: number; color: Rgb }[] = [
  { at: 0, color: [255, 244, 232] },
  { at: 0.5, color: [249, 168, 105] },
  { at: 1, color: [191, 58, 11] },
];

function escapeXml(text: string): string {
  // XML 1.0 has no place for control characters; one in a category name would void the file
  const printable = [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 || code === 9 || code === 10 || code === 13;
  });
  return printable
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A coordinate for the markup: one decimal, and never `NaN`. */
function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '0';
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function heatColor(intensity: number): Rgb {
  const t = Math.min(Math.max(Number.isFinite(intensity) ? intensity : 0, 0), 1);
  const upper = HEAT_STOPS.findIndex((stop) => stop.at >= t);
  const hi = HEAT_STOPS[Math.max(upper, 1)] ?? HEAT_STOPS[HEAT_STOPS.length - 1]!;
  const lo = HEAT_STOPS[Math.max(upper, 1) - 1]!;
  const k = hi.at === lo.at ? 0 : (t - lo.at) / (hi.at - lo.at);
  return [0, 1, 2].map((i) => lo.color[i]! + (hi.color[i]! - lo.color[i]!) * k) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

const INK_RGB: Rgb = [31, 35, 40];

/** Whichever of white and ink has more contrast against the cell. */
function textOn(background: Rgb): string {
  const lum = luminance(background);
  const withWhite = 1.05 / (lum + 0.05);
  const withInk = (lum + 0.05) / (luminance(INK_RGB) + 0.05);
  return withWhite >= withInk ? '#ffffff' : INK;
}

/** Groups thousands with a non-breaking space, which keeps «1 280» in one piece. */
function grouped(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * A number short enough for a cell. Rubles are in thousands, with one decimal under 10 (`8,3`,
 * `27`, `1 280`); dollars keep the sign and say so (`$870`, `$1.2k`, `$12k`).
 */
export function formatCompact(value: number, currency: MoneyCurrency): string {
  if (!Number.isFinite(value)) return '';
  if (value < 0) return `−${formatCompact(-value, currency)}`;

  if (currency === 'RUB') {
    const tenths = Math.round(value / 100) / 10;
    // A painted cell reading «0,0» looks like an error; a few dozen rubles are «<0,1»
    if (value > 0 && tenths === 0) return '<0,1';
    return tenths < 10 ? tenths.toFixed(1).replace('.', ',') : grouped(value / 1000);
  }

  if (value > 0 && Math.round(value) === 0) return '<$1';
  if (Math.round(value) < 1000) return `$${Math.round(value)}`;
  const tenths = Math.round(value / 100) / 10;
  return tenths < 10 ? `$${tenths.toFixed(1)}k` : `$${grouped(value / 1000)}k`;
}

function clip(label: string): string {
  const chars = [...label];
  return chars.length > MAX_LABEL_CHARS
    ? `${chars.slice(0, MAX_LABEL_CHARS - 1).join('')}…`
    : label;
}

interface TextOptions {
  size: number;
  fill?: string;
  weight?: 400 | 600;
  anchor?: 'start' | 'middle' | 'end';
}

/** One line of text with its baseline at `y`. */
function text(content: string, x: number, y: number, options: TextOptions): string {
  if (content === '') return '';
  const { size, fill = INK, weight = 400, anchor = 'start' } = options;
  const attrs = `x="${num(x)}" y="${num(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}"`;
  return `<text ${attrs} text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

/** Baseline that centres digits and capitals vertically in a box. */
function middle(top: number, height: number, size: number): number {
  return top + height / 2 + size * 0.36;
}

function rect(x: number, y: number, w: number, h: number, extra: string): string {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ${extra}/>`;
}

interface Layout {
  width: number;
  cellW: number;
  cellSize: number;
  headSize: number;
  firstX: number;
  sumX: number;
}

function layoutOf(model: HeatmapModel): Layout {
  const count = Math.max(model.columns.length, 1);
  const fixed = PAD * 2 + LABEL_W + SUM_W;
  const natural = Math.min(
    Math.max(Math.floor((TARGET_W - fixed) / count), MIN_CELL_W),
    MAX_CELL_W,
  );
  const titleW = [...model.title].length * TITLE_SIZE * TITLE_EM + PAD * 2;
  const width = Math.ceil(Math.max(fixed + count * natural, titleW, MIN_W));
  const cellW = (width - fixed) / count;
  return {
    width,
    cellW,
    // A narrow cell still has to hold its number; 13 is the floor for a phone screen
    cellSize: cellW >= 64 ? 19 : cellW >= 54 ? 17 : cellW >= 48 ? 15 : 13,
    headSize: cellW >= 54 ? 16 : 13,
    firstX: PAD + LABEL_W,
    sumX: PAD + LABEL_W + cellW * count,
  };
}

/** Contiguous columns that print the same month (or year) label once above them. */
function monthRuns(model: HeatmapModel): { label: string; from: number; to: number }[] {
  const runs: { label: string; from: number; to: number }[] = [];
  model.columns.forEach((column, i) => {
    const last = runs.at(-1);
    if (last && last.label === column.monthLabel) last.to = i;
    else runs.push({ label: column.monthLabel, from: i, to: i });
  });
  return runs.filter((run) => run.label !== '');
}

function gridRow(
  row: HeatmapRow,
  top: number,
  model: HeatmapModel,
  layout: Layout,
  heat: boolean,
): string {
  const { cellW, cellSize, firstX, sumX } = layout;
  const parts: string[] = [];
  const bold = !heat;

  parts.push(
    text(clip(row.label), PAD, middle(top, ROW_H, LABEL_SIZE), {
      size: LABEL_SIZE,
      weight: bold ? 600 : 400,
    }),
  );

  const max = Math.max(0, ...row.values.map((value) => value ?? 0));
  const boxW = cellW - COL_GAP;
  const boxH = ROW_H - ROW_GAP;
  row.values.forEach((value, i) => {
    const x = firstX + i * cellW;
    if (value === null || !Number.isFinite(value)) {
      parts.push(rect(x, top, boxW, boxH, `rx="5" fill="${heat ? BLANK : SUM_FILL}"`));
      return;
    }
    // Every cell of the row is judged against that row's own biggest: Housing's rent would
    // otherwise wash out everything else
    const fill = heat ? heatColor(max > 0 ? Math.max(value / max, 0.06) : 0) : null;
    parts.push(rect(x, top, boxW, boxH, `rx="5" fill="${fill ? hex(fill) : SUM_FILL}"`));
    parts.push(
      text(formatCompact(value, model.currency), x + boxW / 2, middle(top, boxH, cellSize), {
        size: cellSize,
        weight: bold ? 600 : 400,
        fill: fill ? textOn(fill) : INK,
        anchor: 'middle',
      }),
    );
  });

  parts.push(rect(sumX, top, SUM_W, boxH, `rx="5" fill="${SUM_FILL}"`));
  parts.push(
    text(formatCompact(row.total, model.currency), sumX + SUM_W / 2, middle(top, boxH, cellSize), {
      size: cellSize,
      weight: 600,
      anchor: 'middle',
    }),
  );
  return parts.join('');
}

interface LegendItem {
  width: number;
  /** Markup for the item with its left edge at `x` and its centre line at `y`. */
  draw(x: number, y: number): string;
}

const LEGEND_GAP = 22;
const SWATCH_W = 22;
const STEPS = 6;

function legendItems(model: HeatmapModel): LegendItem[] {
  // Inter's lowercase Cyrillic runs a little over half an em
  const textWidth = (label: string) => [...label].length * LEGEND_SIZE * 0.56;
  const caption = (label: string, x: number, y: number) =>
    text(label, x, y + LEGEND_SIZE * 0.36, { size: LEGEND_SIZE, fill: MUTED });

  const items: LegendItem[] = [];

  if (model.columns.some((column) => column.highlight)) {
    const label =
      model.period === 'bucket' ? 'только что закрытая неделя' : 'только что закрытый месяц';
    items.push({
      width: SWATCH_W + 8 + textWidth(label),
      draw: (x, y) =>
        rect(x, y - 8, SWATCH_W, 16, `rx="4" fill="none" stroke="${INK}" stroke-width="2.5"`) +
        caption(label, x + SWATCH_W + 8, y),
    });
  }

  if (model.columns.some((column) => column.current)) {
    const label = 'идёт сейчас';
    items.push({
      width: SWATCH_W + 8 + textWidth(label),
      draw: (x, y) =>
        rect(
          x,
          y - 8,
          SWATCH_W,
          16,
          `rx="4" fill="none" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="4 3"`,
        ) + caption(label, x + SWATCH_W + 8, y),
    });
  }

  // The colour scale: from nothing up to the biggest cell of the row
  const label = 'цвет — от нуля до максимума в строке';
  items.push({
    width: STEPS * 11 + 8 + textWidth(label),
    draw: (x, y) => {
      const strip = Array.from({ length: STEPS }, (_, i) =>
        rect(x + i * 11, y - 8, 11, 16, `fill="${hex(heatColor(i / (STEPS - 1)))}"`),
      ).join('');
      return strip + caption(label, x + STEPS * 11 + 8, y);
    },
  });
  return items;
}

/** The legend flows left to right and wraps when the picture is too narrow for it. */
function legend(model: HeatmapModel, top: number, width: number): { svg: string; bottom: number } {
  const parts: string[] = [];
  let x = PAD;
  let y = top;
  for (const item of legendItems(model)) {
    if (x > PAD && x + item.width > width - PAD) {
      x = PAD;
      y += 26;
    }
    parts.push(item.draw(x, y));
    x += item.width + LEGEND_GAP;
  }
  return { svg: parts.join(''), bottom: y + 8 };
}

/** Pure: the same model always gives the same markup. Fonts are the PNG step's business. */
export function renderHeatmapSvg(model: HeatmapModel): string {
  const layout = layoutOf(model);
  const { width, cellW, headSize, firstX } = layout;
  const body: string[] = [];

  let y = PAD;
  body.push(text(model.title, PAD, y + TITLE_SIZE * 0.8, { size: TITLE_SIZE, weight: 600 }));
  y += TITLE_SIZE + 14;

  let height: number;
  if (model.rows.length === 0) {
    body.push(
      text('За выбранный период трат нет.', PAD, y + 28, { size: LABEL_SIZE, fill: MUTED }),
    );
    height = y + 28 + PAD;
  } else {
    const runs = monthRuns(model);
    const monthTop = y;
    if (runs.length > 0) y += MONTH_H;
    const headTop = y;
    y += HEAD_H + 4;

    for (const run of runs) {
      const left = firstX + run.from * cellW;
      const right = firstX + (run.to + 1) * cellW - COL_GAP;
      body.push(
        text(run.label, (left + right) / 2, monthTop + 15, {
          size: 14,
          weight: 600,
          fill: MUTED,
          anchor: 'middle',
        }),
        `<line x1="${num(left + 4)}" y1="${num(monthTop + 22)}" x2="${num(right - 4)}" y2="${num(monthTop + 22)}" stroke="${RULE}" stroke-width="1.5"/>`,
      );
    }

    model.columns.forEach((column, i) => {
      body.push(
        text(column.label, firstX + i * cellW + (cellW - COL_GAP) / 2, headTop + 20, {
          size: headSize,
          weight: 600,
          fill: column.highlight ? INK : MUTED,
          anchor: 'middle',
        }),
      );
    });
    body.push(
      text('Σ', layout.sumX + SUM_W / 2, headTop + 20, {
        size: headSize + 1,
        weight: 600,
        fill: MUTED,
        anchor: 'middle',
      }),
    );

    for (const row of model.rows) {
      body.push(gridRow(row, y, model, layout, true));
      y += ROW_H;
    }

    y += 6;
    body.push(
      `<line x1="${PAD}" y1="${num(y - 3)}" x2="${num(width - PAD)}" y2="${num(y - 3)}" stroke="${RULE}" stroke-width="1.5"/>`,
    );
    body.push(gridRow(model.totals, y, model, layout, false));
    const gridBottom = y + ROW_H - ROW_GAP;

    // Outlines go last so they sit on top of the cells they frame
    model.columns.forEach((column, i) => {
      const x = firstX + i * cellW - 2;
      const top = headTop - 2;
      const frame = (stroke: string) =>
        rect(x, top, cellW - COL_GAP + 4, gridBottom - top + 2, `rx="8" fill="none" ${stroke}`);
      if (column.current) {
        body.push(frame(`stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="6 4"`));
      }
      if (column.highlight) body.push(frame(`stroke="${INK}" stroke-width="2.5"`));
    });

    const key = legend(model, gridBottom + 32, width);
    body.push(key.svg);
    y = key.bottom;
    if (model.note) {
      y += 24;
      body.push(text(model.note, PAD, y, { size: LEGEND_SIZE, fill: MUTED }));
    }
    height = y + PAD;
  }

  const size = `width="${width}" height="${num(height)}" viewBox="0 0 ${width} ${num(height)}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${size} font-family="Inter">`,
    rect(0, 0, width, height, 'fill="#ffffff"'),
    ...body,
    '</svg>',
  ].join('');
}

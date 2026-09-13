import { escapeHtml } from './format.js';

const BAR_WIDTH = 12;
const MAX_LABEL = 14;

export interface BarPoint {
  label: string;
  value: number;
}

/**
 * Monospace bar chart. Numbers alone hide the shape of a month; a bar next to each one
 * shows it without leaving the message. Values are drawn from magnitude, so a negative
 * point still gets a bar and keeps its sign in the printed figure.
 */
export function renderBars(points: BarPoint[], format: (value: number) => string): string {
  if (points.length === 0) return '';

  const peak = Math.max(...points.map((point) => Math.abs(point.value)), 0);
  const labelWidth = Math.min(Math.max(...points.map((point) => point.label.length), 0), MAX_LABEL);

  const lines = points.map((point) => {
    const label = point.label.slice(0, MAX_LABEL).padEnd(labelWidth);
    const filled = peak > 0 ? Math.round((Math.abs(point.value) / peak) * BAR_WIDTH) : 0;
    const bar = '█'.repeat(Math.max(filled, point.value === 0 ? 0 : 1)).padEnd(BAR_WIDTH);
    return `${label} ${bar} ${format(point.value)}`;
  });

  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

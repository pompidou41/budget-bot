import type { Txn } from '../analytics/dataset.js';
import { bucketRange, monthShort, periodKey } from '../analytics/queries.js';
import { categoryLabel } from './category-labels.js';
import { formatMoney, type MoneyCurrency } from './format.js';
import type { Reference } from './reference.js';
import { buildReportData, type ReportPeriod, type ReportState } from './report.js';

export interface HeatmapColumn {
  key: string;
  /** What heads the column: `1–8` for a bucket, `окт` for a month. */
  label: string;
  /** Printed once above a run of columns that share it: the month of a bucket, the year of a month. */
  monthLabel: string;
  /** The period still in progress: its numbers are not final. */
  current: boolean;
  /** The period the picture is about, e.g. the bucket a recap has just closed. */
  highlight: boolean;
}

export interface HeatmapRow {
  label: string;
  /** One per column; null where nothing was spent — not the same as an expense of 0. */
  values: (number | null)[];
  total: number;
}

/** Everything the picture shows, with no drawing decisions in it. */
export interface HeatmapModel {
  title: string;
  period: ReportPeriod;
  currency: MoneyCurrency;
  columns: HeatmapColumn[];
  /** Top-level expense categories with any spending in the window, heaviest first. */
  rows: HeatmapRow[];
  totals: HeatmapRow;
  /** A line under the legend, e.g. what the picture deliberately leaves out. */
  note: string;
}

function title(state: ReportState): string {
  const unit = state.period === 'bucket' ? 'неделям' : 'месяцам';
  const scale = state.currency === 'RUB' ? 'тыс ₽' : 'USD';
  const scope = state.categories.length > 0 ? ' · выбранные категории' : '';
  return `Траты по ${unit} · ${scale} · ${state.oneOff ? 'с разовыми' : 'без разовых'}${scope}`;
}

/**
 * The `/report` numbers as a grid for the picture: the same rows, periods and totals the table
 * shows, taken from the same {@link buildReportData}, so the two never disagree.
 */
export function buildHeatmap(
  txns: Txn[],
  ref: Reference,
  today: string,
  state: ReportState,
  highlight?: string,
): HeatmapModel {
  const data = buildReportData(txns, ref, today, state);
  const currentKey = periodKey(today, state.period);
  // A window crossing New Year needs the year on its month labels, or «янв» reads as the past one
  const years = new Set(data.periods.map((key) => key.slice(0, 4)));

  const columns: HeatmapColumn[] = data.periods.map((key) => {
    const year = key.slice(0, 4);
    const monthName = monthShort(key.slice(0, 7));
    const bucket = state.period === 'bucket';
    return {
      key,
      label: bucket ? bucketRange(key) : monthName,
      monthLabel: bucket ? (years.size > 1 ? `${monthName} ${year.slice(2)}` : monthName) : year,
      current: key === currentKey,
      highlight: key === highlight,
    };
  });

  const rows: HeatmapRow[] = data.rows.map((row) => ({
    label: categoryLabel(row.category),
    values: data.periods.map((key) => row.byPeriod.get(key) ?? null),
    total: row.total,
  }));

  const totalValues = data.periods.map((key, i) =>
    rows.some((row) => row.values[i] !== null) ? (data.totals.get(key) ?? 0) : null,
  );
  const totals: HeatmapRow = {
    label: 'Итого',
    values: totalValues,
    total: totalValues.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  };

  const note =
    !state.oneOff && data.oneOffTotal > 0
      ? `Разовые за период: ${formatMoney(Math.round(data.oneOffTotal), state.currency)} — не входят`
      : '';

  return {
    title: title(state),
    period: state.period,
    currency: state.currency,
    columns,
    rows,
    totals,
    note,
  };
}

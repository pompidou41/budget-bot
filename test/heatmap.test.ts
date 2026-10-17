import { describe, expect, it } from 'vitest';
import type { Txn } from '../src/analytics/dataset.js';
import { buildHeatmap, type HeatmapModel } from '../src/domain/heatmap.js';
import { DEFAULT_REPORT, type ReportState } from '../src/domain/report.js';
import { formatCompact, renderHeatmapSvg } from '../src/render/heatmap-svg.js';
import { svgToPng } from '../src/render/png.js';
import { ref } from './fixtures.js';

// A Monday-ish mid-October day: the window of eight buckets ends with 9–16 October
const TODAY = '2026-10-12';

function txn(date: string, rub: number, overrides: Partial<Txn> = {}): Txn {
  return {
    date,
    month: date.slice(0, 7),
    type: 'Расход',
    account: 'T_MAIN',
    toAccount: '',
    amount: rub,
    currency: 'RUB',
    usd: rub / 80,
    rub,
    category: 'Food',
    subcategory: 'Groceries',
    comment: '',
    oneOff: false,
    ...overrides,
  };
}

const USD: ReportState = { ...DEFAULT_REPORT, currency: 'USD' };

describe('buildHeatmap', () => {
  const txns = [
    txn('2026-09-02', 10_000),
    txn('2026-09-20', 5_000),
    txn('2026-10-03', 40_000, { category: 'Transport' }),
    txn('2026-10-04', 20_000, { category: 'Transport' }),
    txn('2026-10-10', 7_000),
  ];

  it('makes a row per spending category, heaviest first, in Russian', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    // Transport 60 000 beats Food 22 000, although Food is first in the sheet
    expect(model.rows.map((row) => row.label)).toEqual(['Транспорт', 'Еда']);
    expect(model.rows.map((row) => row.total)).toEqual([60_000, 22_000]);
  });

  it('keeps income, transfers and one-offs out of the grid unless asked', () => {
    const noisy = [
      ...txns,
      txn('2026-10-05', 900_000, { type: 'Доход', category: 'Income' }),
      txn('2026-10-05', 50_000, { type: 'Перевод', category: 'Transfer' }),
      txn('2026-10-06', 30_000, { category: 'Misc', oneOff: true }),
    ];

    const plain = buildHeatmap(noisy, ref, TODAY, DEFAULT_REPORT);
    expect(plain.rows.map((row) => row.label)).toEqual(['Транспорт', 'Еда']);
    expect(plain.title).toContain('без разовых');
    expect(plain.note).toContain('30 000 ₽');

    const withOneOff = buildHeatmap(noisy, ref, TODAY, { ...DEFAULT_REPORT, oneOff: true });
    expect(withOneOff.rows.map((row) => row.label)).toContain('Misc');
    expect(withOneOff.title).toContain('с разовыми');
    expect(withOneOff.note).toBe('');
  });

  it('tells a period with no spending (null) from an expense of zero', () => {
    const model = buildHeatmap(
      [txn('2026-09-03', 0), txn('2026-10-04', 100)],
      ref,
      TODAY,
      DEFAULT_REPORT,
    );
    const columns = model.columns.map((column) => column.key);
    const values = model.rows[0]!.values;

    expect(values[columns.indexOf('2026-09-b1')]).toBe(0);
    expect(values[columns.indexOf('2026-10-b1')]).toBe(100);
    expect(values.filter((value) => value === null)).toHaveLength(6);
  });

  it('marks the period in progress and the one a recap just closed', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT, '2026-10-b1');

    expect(model.columns).toHaveLength(8);
    expect(model.columns.filter((c) => c.current).map((c) => c.key)).toEqual(['2026-10-b2']);
    expect(model.columns.filter((c) => c.highlight).map((c) => c.key)).toEqual(['2026-10-b1']);
    // Only the last column is the present
    expect(model.columns.at(-1)).toMatchObject({ key: '2026-10-b2', current: true });
    expect(buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT).columns.some((c) => c.highlight)).toBe(
      false,
    );
  });

  it('labels buckets by day range under their month', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    expect(model.columns.map((c) => c.label)).toEqual([
      '17–24',
      '25–31',
      '1–8',
      '9–16',
      '17–24',
      '25–30',
      '1–8',
      '9–16',
    ]);
    expect(model.columns.map((c) => c.monthLabel)).toEqual([
      'авг',
      'авг',
      'сен',
      'сен',
      'сен',
      'сен',
      'окт',
      'окт',
    ]);
  });

  it('puts the year on the months of a window that crosses New Year', () => {
    const model = buildHeatmap(txns, ref, '2027-01-12', DEFAULT_REPORT);

    expect(model.columns.map((c) => c.monthLabel)).toEqual([
      'ноя 26',
      'ноя 26',
      'дек 26',
      'дек 26',
      'дек 26',
      'дек 26',
      'янв 27',
      'янв 27',
    ]);
  });

  it('shows months as columns named by month, grouped under their year', () => {
    const model = buildHeatmap(txns, ref, TODAY, { ...DEFAULT_REPORT, period: 'month', count: 3 });

    expect(model.columns.map((c) => c.label)).toEqual(['авг', 'сен', 'окт']);
    expect(model.columns.map((c) => c.monthLabel)).toEqual(['2026', '2026', '2026']);
    expect(model.columns.map((c) => c.current)).toEqual([false, false, true]);
    expect(model.title).toContain('по месяцам');
    expect(model.rows.map((row) => row.values)).toEqual([
      [null, null, 60_000],
      [null, 15_000, 7_000],
    ]);
  });

  it('adds the columns up in the totals row and leaves empty periods null', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    expect(model.totals.label).toBe('Итого');
    expect(model.totals.values).toEqual([null, null, 10_000, null, 5_000, null, 60_000, 7_000]);
    expect(model.totals.total).toBe(82_000);
    expect(model.totals.total).toBe(model.rows.reduce((sum, row) => sum + row.total, 0));
  });

  it('adds up the amounts of the chosen currency and says which in the title', () => {
    const rubles = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);
    const dollars = buildHeatmap(txns, ref, TODAY, USD);

    expect(rubles.currency).toBe('RUB');
    expect(rubles.title).toBe('Траты по неделям · тыс ₽ · без разовых');
    expect(dollars.currency).toBe('USD');
    expect(dollars.title).toBe('Траты по неделям · USD · без разовых');
    expect(dollars.rows[0]?.total).toBeCloseTo(60_000 / 80);
  });

  it('keeps only the categories that were picked', () => {
    const model = buildHeatmap(txns, ref, TODAY, { ...DEFAULT_REPORT, categories: ['Food'] });

    expect(model.rows.map((row) => row.label)).toEqual(['Еда']);
    expect(model.title).toContain('выбранные категории');
  });

  it('has no rows when nothing was spent in the window', () => {
    const model = buildHeatmap([], ref, TODAY, DEFAULT_REPORT);

    expect(model.rows).toEqual([]);
    expect(model.totals.total).toBe(0);
    expect(model.columns).toHaveLength(8);
  });
});

describe('formatCompact', () => {
  it('writes rubles in thousands, with a decimal under ten', () => {
    expect(formatCompact(8_300, 'RUB')).toBe('8,3');
    expect(formatCompact(600, 'RUB')).toBe('0,6');
    expect(formatCompact(27_000, 'RUB')).toBe('27');
    expect(formatCompact(128_400, 'RUB')).toBe('128');
    expect(formatCompact(1_280_000, 'RUB')).toBe('1 280');
    // 9 960 would print as «10,0»; it is ten thousand to the eye
    expect(formatCompact(9_960, 'RUB')).toBe('10');
  });

  it('writes dollars whole, then as thousands with a k', () => {
    expect(formatCompact(870, 'USD')).toBe('$870');
    expect(formatCompact(1_200, 'USD')).toBe('$1.2k');
    expect(formatCompact(12_000, 'USD')).toBe('$12k');
    expect(formatCompact(999.6, 'USD')).toBe('$1.0k');
  });

  it('marks a tiny amount as tiny instead of printing zero', () => {
    expect(formatCompact(31, 'RUB')).toBe('<0,1');
    expect(formatCompact(0.4, 'USD')).toBe('<$1');
  });

  it('never prints a broken number', () => {
    expect(formatCompact(NaN, 'RUB')).toBe('');
    expect(formatCompact(Infinity, 'USD')).toBe('');
    expect(formatCompact(-8_300, 'RUB')).toBe('−8,3');
  });
});

describe('renderHeatmapSvg', () => {
  const model: HeatmapModel = {
    title: 'Траты по неделям · тыс ₽ · без разовых',
    period: 'bucket',
    currency: 'RUB',
    columns: [
      { key: 'a', label: '1–8', monthLabel: 'окт', current: false, highlight: true },
      { key: 'b', label: '9–16', monthLabel: 'окт', current: true, highlight: false },
      { key: 'c', label: '17–24', monthLabel: 'окт', current: false, highlight: false },
    ],
    rows: [
      { label: 'Cafes & coffee', values: [1_000, null, 10_000], total: 11_000 },
      { label: 'Жильё', values: [null, 3_000, 0], total: 3_000 },
    ],
    totals: { label: 'Итого', values: [1_000, 3_000, 10_000], total: 14_000 },
    note: '',
  };

  /** Rounded boxes are the data cells: rows plus totals, columns plus Σ. */
  function cells(svg: string): number {
    return svg.match(/rx="5"/g)?.length ?? 0;
  }

  it('draws a cell for every row and column, plus the Σ column and the totals row', () => {
    const svg = renderHeatmapSvg(model);

    expect(cells(svg)).toBe((model.rows.length + 1) * (model.columns.length + 1));
    expect(svg).toContain('Σ');
    expect(svg).toContain('Итого');
    expect(svg).toContain('>1,0<');
    expect(svg).toContain('>10<');
  });

  it('escapes every name and title, so a stray & or < cannot break the picture', () => {
    const svg = renderHeatmapSvg({
      ...model,
      title: 'A & B <c>',
      rows: [{ label: '<b>"x"</b>', values: [1_000, 2_000, 3_000], total: 6_000 }],
    });

    expect(renderHeatmapSvg(model)).toContain('Cafes &amp; coffee');
    expect(svg).toContain('A &amp; B &lt;c&gt;');
    expect(svg).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(svg).not.toContain('<b>');
    expect(svg).not.toContain('<c>');
  });

  it('drops control characters, which XML cannot carry', () => {
    const svg = renderHeatmapSvg({
      ...model,
      rows: [{ label: 'Еда\u0001\u0008x', values: [1_000, 2_000, 3_000], total: 6_000 }],
    });

    expect(svg).toContain('>Едаx<');
    // eslint-disable-next-line no-control-regex
    expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });

  it('never prints NaN, undefined or Infinity, whatever the numbers are', () => {
    const broken = renderHeatmapSvg({
      ...model,
      rows: [{ label: 'Еда', values: [NaN, Infinity, -Infinity], total: NaN }],
      totals: { label: 'Итого', values: [NaN, null, Infinity], total: NaN },
    });

    for (const svg of [renderHeatmapSvg(model), broken]) {
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it('frames the closed period with a solid line and the current one with a dashed line', () => {
    const svg = renderHeatmapSvg(model);

    expect(svg.match(/stroke-dasharray="6 4"/g)).toHaveLength(1);
    expect(svg.match(/rx="8" fill="none" stroke="#1f2328"/g)).toHaveLength(1);

    const plain = renderHeatmapSvg({
      ...model,
      columns: model.columns.map((c) => ({ ...c, current: false, highlight: false })),
    });
    expect(plain).not.toContain('stroke-dasharray="6 4"');
    expect(plain).not.toContain('rx="8"');
  });

  it('scales each row against its own maximum and turns the text white on dark cells', () => {
    const svg = renderHeatmapSvg({
      ...model,
      rows: [{ label: 'Еда', values: [1_000, 100_000, 50_000], total: 151_000 }],
    });

    // The row's biggest cell takes the darkest colour, white text on it; its smallest is pale
    expect(svg).toMatch(/fill="#bf3a0b"[^>]*\/><text[^>]*fill="#ffffff"[^>]*>100<\/text>/);
    expect(svg).toMatch(/fill="#fe[0-9a-f]{4}"[^>]*\/><text[^>]*fill="#1f2328"[^>]*>1,0<\/text>/);
  });

  it('says so, with no grid, when there is nothing to show', () => {
    const svg = renderHeatmapSvg({ ...model, rows: [] });

    expect(svg).toContain('За выбранный период трат нет.');
    expect(cells(svg)).toBe(0);
  });

  it('is the same every time for the same model', () => {
    expect(renderHeatmapSvg(model)).toBe(renderHeatmapSvg(model));
  });
});

describe('svgToPng', () => {
  it('renders a real PNG at twice the size of the drawing', async () => {
    const svg = renderHeatmapSvg({
      title: 'Траты по неделям · тыс ₽ · без разовых',
      period: 'bucket',
      currency: 'RUB',
      columns: [{ key: 'a', label: '1–8', monthLabel: 'окт', current: false, highlight: false }],
      rows: [{ label: 'Еда', values: [8_300], total: 8_300 }],
      totals: { label: 'Итого', values: [8_300], total: 8_300 },
      note: '',
    });
    const width = Number(svg.match(/<svg[^>]* width="(\d+)"/)?.[1]);

    const png = await svgToPng(svg);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: width and height as big-endian 32-bit numbers right after the signature
    expect(png.readUInt32BE(16)).toBe(width * 2);
    // Glyphs came from the bundled font; a picture with no text would be a few KB
    expect(png.length).toBeGreaterThan(10_000);
  });
});

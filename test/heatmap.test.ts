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

  it('makes a row per spending category, in the order of the sheet, in Russian', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    // Food comes first in the sheet, although Transport's 60 000 beats its 22 000
    expect(model.rows.map((row) => row.label)).toEqual(['Еда', 'Транспорт']);
    expect(model.rows.map((row) => row.total)).toEqual([22_000, 60_000]);
  });

  it('puts the heaviest category first when the report is sorted by sum', () => {
    const model = buildHeatmap(txns, ref, TODAY, { ...DEFAULT_REPORT, sort: 'sum' });

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
    expect(plain.rows.map((row) => row.label)).toEqual(['Еда', 'Транспорт']);
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
      [null, 15_000, 7_000],
      [null, null, 60_000],
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
    expect(dollars.rows.find((row) => row.label === 'Транспорт')?.total).toBeCloseTo(60_000 / 80);
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
    expect(model.months.every((month) => month.total === null)).toBe(true);
  });
});

describe('buildHeatmap months', () => {
  const txns = [
    txn('2026-09-02', 10_000),
    txn('2026-09-20', 5_000),
    txn('2026-10-03', 40_000, { category: 'Transport' }),
    txn('2026-10-04', 20_000, { category: 'Transport' }),
    txn('2026-10-10', 7_000),
  ];

  it('cuts a rolling window into runs of columns of one calendar month', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    // 17–24 and 25–31 August, four buckets of September, two of October
    expect(model.months.map(({ from, to }) => [from, to])).toEqual([
      [0, 1],
      [2, 5],
      [6, 7],
    ]);
  });

  it('skips a month the window starts in the middle of, rather than understate it', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    expect(model.columns[0]?.key).toBe('2026-08-b3');
    expect(model.months[0]?.total).toBeNull();
  });

  it('totals a whole month as the sum of its buckets in the totals row', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);
    const september = model.months[1]!;

    // Only the 1–8 and 17–24 buckets of September have anything in them
    expect(september.total).toBe(15_000);
    expect(september.total).toBe(
      model.totals.values
        .slice(september.from, september.to + 1)
        .reduce<number>((sum, value) => sum + (value ?? 0), 0),
    );
  });

  it('shows the month in progress, marked as such, and no other', () => {
    const model = buildHeatmap(txns, ref, TODAY, DEFAULT_REPORT);

    expect(model.months.map((month) => month.current)).toEqual([false, false, true]);
    // The first bucket of October is in the window, so its total is there, unfinished as it is
    expect(model.months[2]?.total).toBe(67_000);
  });

  it('keeps a month the window opens on the first bucket of', () => {
    // Six buckets back from 9–16 October start exactly on 1–8 September
    const model = buildHeatmap(txns, ref, TODAY, { ...DEFAULT_REPORT, count: 6 });

    expect(model.months.map(({ from, to, total }) => ({ from, to, total }))).toEqual([
      { from: 0, to: 3, total: 15_000 },
      { from: 4, to: 5, total: 67_000 },
    ]);
  });

  it('leaves a whole month with nothing spent without a total', () => {
    // Twelve buckets reach back to the second half of July; August has no expenses at all
    const model = buildHeatmap(txns, ref, TODAY, { ...DEFAULT_REPORT, count: 12 });

    expect(model.columns[0]?.key).toBe('2026-07-b3');
    expect(model.months.map((month) => month.total)).toEqual([null, null, 15_000, 67_000]);
  });

  it('follows the currency and the one-off switch of the totals row', () => {
    const noisy = [...txns, txn('2026-09-05', 30_000, { oneOff: true })];

    expect(buildHeatmap(noisy, ref, TODAY, DEFAULT_REPORT).months[1]?.total).toBe(15_000);
    expect(
      buildHeatmap(noisy, ref, TODAY, { ...DEFAULT_REPORT, oneOff: true }).months[1]?.total,
    ).toBe(45_000);
    expect(buildHeatmap(noisy, ref, TODAY, USD).months[1]?.total).toBeCloseTo(15_000 / 80);
  });

  it('has none for a months report, whose columns are the months already', () => {
    const model = buildHeatmap(txns, ref, TODAY, { ...DEFAULT_REPORT, period: 'month', count: 3 });

    expect(model.months).toEqual([]);
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
    months: [],
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

  describe('the «За месяц» row', () => {
    // Four columns of September, then two of October, the second of which is in progress
    const columns = [
      ['1–8', 'сен'],
      ['9–16', 'сен'],
      ['17–24', 'сен'],
      ['25–30', 'сен'],
      ['1–8', 'окт'],
      ['9–16', 'окт'],
    ].map(([label, monthLabel], i) => ({
      key: `c${i}`,
      label: label!,
      monthLabel: monthLabel!,
      current: i === 5,
      highlight: false,
    }));
    const monthly: HeatmapModel = {
      ...model,
      columns,
      rows: [{ label: 'Жильё', values: [1_000, 2_000, 3_000, 4_000, 5_000, 6_000], total: 21_000 }],
      totals: {
        label: 'Итого',
        values: [1_000, 2_000, 3_000, 4_000, 5_000, 6_000],
        total: 21_000,
      },
      months: [
        { from: 0, to: 3, total: 98_000, current: false },
        { from: 4, to: 5, total: 41_000, current: true },
      ],
    };
    const without = renderHeatmapSvg({ ...monthly, months: [] });

    /** Widths of the rounded boxes, in drawing order. */
    function widths(svg: string): number[] {
      return [...svg.matchAll(/<rect [^>]*?width="([\d.]+)"[^>]*rx="5"/g)].map((m) => Number(m[1]));
    }

    function height(svg: string): number {
      return Number(svg.match(/<svg[^>]* height="([\d.]+)"/)?.[1]);
    }

    it('adds a labelled row below «Итого» with one merged box per month', () => {
      const svg = renderHeatmapSvg(monthly);

      expect(svg).toContain('>За месяц<');
      expect(cells(svg)).toBe(cells(without) + 2);
      expect(height(svg)).toBeGreaterThan(height(without));

      // A merged box is as wide as its columns and the gaps between them, minus the last gap
      const cell = widths(without)[0]!;
      const merged = widths(svg).slice(widths(without).length);
      expect(merged).toEqual([4 * cell + 3 * 8, 2 * cell + 8]);
    });

    it('prints the month total in the same short form as the cells', () => {
      const svg = renderHeatmapSvg(monthly);

      expect(svg).toMatch(/rx="5" fill="#ecece8"\/><text[^>]*font-weight="600"[^>]*>98<\/text>/);
    });

    it('says «пока» on the month in progress and dashes its box', () => {
      const svg = renderHeatmapSvg(monthly);

      expect(svg).toContain('>41 пока<');
      expect(svg).not.toContain('>98 пока<');
      // The column frame is dashed already; the month box is the second dashed outline
      expect(svg.match(/stroke-dasharray="6 4"/g)).toHaveLength(2);
      expect(svg).toMatch(
        /rx="5" fill="#ecece8" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="6 4"/,
      );
    });

    it('leaves «пока» off when the month in progress is a single narrow column', () => {
      const svg = renderHeatmapSvg({
        ...monthly,
        months: [
          { from: 0, to: 4, total: 98_000, current: false },
          { from: 5, to: 5, total: 6_000, current: true },
        ],
      });

      expect(svg).toContain('>6,0<');
      expect(svg).not.toContain('пока');
    });

    it('draws nothing for a month without a total, and no row if none has one', () => {
      const cut = renderHeatmapSvg({
        ...monthly,
        months: [
          { from: 0, to: 3, total: null, current: false },
          { from: 4, to: 5, total: 41_000, current: true },
        ],
      });
      expect(cut).toContain('>41 пока<');
      expect(cells(cut)).toBe(cells(without) + 1);

      const none = renderHeatmapSvg({
        ...monthly,
        months: monthly.months.map((month) => ({ ...month, total: null })),
      });
      expect(none).toBe(without);
      expect(none).not.toContain('За месяц');
    });

    it('stops the column frames above the merged boxes', () => {
      const svg = renderHeatmapSvg(monthly);

      const frame = svg.match(
        /<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" rx="8"/,
      );
      const box = svg.match(
        /<rect x="[\d.]+" y="([\d.]+)" [^>]*rx="5" fill="#ecece8"[^>]*\/><text[^>]*>98</,
      );
      expect(Number(frame?.[1]) + Number(frame?.[2])).toBeLessThan(Number(box?.[1]));
    });

    it('moves the legend below the row, and the note below the legend', () => {
      const note = 'Разовые за период: 24 000 ₽ — не входят';
      const lastY = (svg: string, content: string) =>
        Number(svg.match(new RegExp(`y="([\\d.]+)"[^>]*>${content}<`))?.[1]);

      const svg = renderHeatmapSvg({ ...monthly, note });
      const plain = renderHeatmapSvg({ ...monthly, months: [], note });

      expect(lastY(svg, 'идёт сейчас')).toBeGreaterThan(lastY(plain, 'идёт сейчас'));
      expect(lastY(svg, note)).toBeGreaterThan(lastY(svg, 'идёт сейчас'));
      expect(height(svg)).toBeGreaterThan(lastY(svg, note));
    });

    it('never prints NaN, whatever a month total is', () => {
      const svg = renderHeatmapSvg({
        ...monthly,
        months: [
          { from: 0, to: 3, total: NaN, current: false },
          { from: 4, to: 5, total: Infinity, current: true },
        ],
      });

      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      expect(svg).not.toContain('За месяц');
    });
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
      months: [],
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

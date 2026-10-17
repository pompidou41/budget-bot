import { describe, expect, it } from 'vitest';
import {
  buildMatrix,
  byCategory,
  periodTotals,
  recentPeriods,
  type MatrixRow,
  type Period,
} from '../src/analytics/queries.js';
import type { Txn } from '../src/analytics/dataset.js';
import { reportKeyboard } from '../src/bot/keyboards.js';
import {
  buildReportData,
  COUNT_CHOICES,
  decodeReport,
  DEFAULT_REPORT,
  encodeReport,
  encodeReportImage,
  MAX_TABLE_PERIODS,
  otherSort,
  REPORT_PREFIX,
  renderReportHtml,
  renderReportRich,
  sortLabel,
  splitPeriods,
  toggleCategory,
  type ReportData,
  type ReportState,
} from '../src/domain/report.js';
import { ref } from './fixtures.js';

const CATEGORIES = ['Food', 'Transport', 'Housing', 'Health', 'Other'];
// The sheet's real category list is longer than the test one
const MANY_CATEGORIES = Array.from({ length: 16 }, (_, i) => `Category ${i + 1}`);

function txn(date: string, usd: number, category = 'Food'): Txn {
  return {
    date,
    month: date.slice(0, 7),
    type: 'Расход',
    account: 'T_MAIN',
    toAccount: '',
    amount: usd,
    currency: 'USD',
    usd,
    rub: usd * 80,
    category,
    subcategory: '',
    comment: '',
    oneOff: false,
  };
}

function data(
  rows: MatrixRow[],
  periods: string[],
  txns: Txn[] = [],
  period: Period = 'bucket',
): ReportData {
  return {
    rows,
    totals: periodTotals(txns, periods, () => true, period),
    periods,
    allCategories: CATEGORIES,
    oneOffTotal: 0,
  };
}

function bucketed(txns: Txn[], periods: string[]): ReportData {
  return data(byCategory(buildMatrix(txns, periods, () => true, 'bucket')), periods, txns);
}

/** Every callback_data in a rich message, with the attribute's escaping undone. */
function richCallbacks(rich: string): string[] {
  return [...rich.matchAll(/data="([^"]*)"/g)].map((m) => m[1]!.replace(/&#34;/g, '"'));
}

describe('report callback codec', () => {
  it('round-trips a state through the 64-byte callback budget', () => {
    const state: ReportState = {
      period: 'month',
      count: 12,
      categories: ['Food', 'Housing'],
      oneOff: true,
      currency: 'RUB',
      sort: 'sum',
    };
    const encoded = encodeReport(state, CATEGORIES);

    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
    expect(decodeReport(encoded, CATEGORIES)).toEqual(state);
  });

  it('writes the period, the count, the mask and the flags as r:b8:<mask>:<flags>', () => {
    // Rubles are the default, so the default screen carries the `r` flag
    expect(encodeReport(DEFAULT_REPORT, CATEGORIES)).toBe('r:b8:-:r');
    expect(encodeReport({ ...DEFAULT_REPORT, currency: 'USD' }, CATEGORIES)).toBe('r:b8:-:-');
    expect(encodeReport({ ...DEFAULT_REPORT, currency: 'USD', oneOff: true }, CATEGORIES)).toBe(
      'r:b8:-:o',
    );
    expect(encodeReport({ ...DEFAULT_REPORT, oneOff: true }, CATEGORIES)).toBe('r:b8:-:or');
    expect(
      encodeReport({ ...DEFAULT_REPORT, oneOff: true, categories: ['Food'] }, CATEGORIES),
    ).toBe('r:b8:1:or');
  });

  it('marks rows sorted by sum with an `s` flag, and the sheet order with none', () => {
    expect(encodeReport({ ...DEFAULT_REPORT, sort: 'sum' }, CATEGORIES)).toBe('r:b8:-:rs');
    expect(encodeReport({ ...DEFAULT_REPORT, currency: 'USD', sort: 'sum' }, CATEGORIES)).toBe(
      'r:b8:-:s',
    );
    expect(encodeReport({ ...DEFAULT_REPORT, oneOff: true, sort: 'sum' }, CATEGORIES)).toBe(
      'r:b8:-:ors',
    );
    expect(encodeReportImage({ ...DEFAULT_REPORT, sort: 'sum' }, CATEGORIES)).toBe('ri:b8:-:rs');
  });

  it('reads the buttons of messages sent before the sort switch as the sheet order', () => {
    // They have no `s`, so an old table opens in the new default
    for (const old of ['r:b8:-:r', 'r:b8:-:-', 'r:m6:3:o', 'ri:b24:-:or', 'r:w8:-:-']) {
      expect(decodeReport(old, CATEGORIES)?.sort).toBe('category');
    }
    expect(decodeReport('r:b8:-:rs', CATEGORIES)?.sort).toBe('sum');
    expect(decodeReport('r:b8:-:s', CATEGORIES)).toEqual({
      ...DEFAULT_REPORT,
      currency: 'USD',
      sort: 'sum',
    });
  });

  it('round-trips every combination of period, flags, currency and sort', () => {
    for (const period of ['bucket', 'month'] as const) {
      for (const count of COUNT_CHOICES[period]) {
        for (const oneOff of [false, true]) {
          for (const currency of ['USD', 'RUB'] as const) {
            for (const sort of ['category', 'sum'] as const) {
              const state: ReportState = {
                period,
                count,
                categories: ['Health'],
                oneOff,
                currency,
                sort,
              };
              expect(decodeReport(encodeReport(state, CATEGORIES), CATEGORIES)).toEqual(state);
            }
          }
        }
      }
    }
  });

  it('still reads the buttons of messages sent before buckets and the currency switch', () => {
    // Those screens showed dollars, and their buttons have no `r` flag
    const before: ReportState = { ...DEFAULT_REPORT, currency: 'USD' };
    // Weeks became buckets: same count, the nearest thing the screen still has
    expect(decodeReport('r:w8:-:-', CATEGORIES)).toEqual(before);
    expect(decodeReport('r:w12:-:o', CATEGORIES)).toEqual({ ...before, count: 12, oneOff: true });
    expect(decodeReport('r:m6:-:-', CATEGORIES)).toEqual({ ...before, period: 'month', count: 6 });
    // Mask 3 is the first two categories
    expect(decodeReport('r:m6:3:o', CATEGORIES)).toEqual({
      ...before,
      period: 'month',
      count: 6,
      categories: ['Food', 'Transport'],
      oneOff: true,
    });
  });

  it('gives an old weekly button a count a bucket screen has', () => {
    expect(decodeReport('r:w5:-:-', CATEGORIES)?.count).toBe(DEFAULT_REPORT.count);
    expect(decodeReport('r:w24:-:-', CATEGORIES)?.count).toBe(24);
  });

  it('keeps the picture prefix apart from the table one but with the same body', () => {
    const state: ReportState = { ...DEFAULT_REPORT, currency: 'RUB', categories: ['Housing'] };
    const image = encodeReportImage(state, CATEGORIES);

    expect(image).toBe('ri:b8:4:r');
    expect(encodeReport(state, CATEGORIES).slice(REPORT_PREFIX.length)).toBe(image.slice(3));
    // The table handler listens for ^r: and must never take the picture's button
    expect(new RegExp(`^${REPORT_PREFIX}`).test(image)).toBe(false);
    expect(decodeReport(image, CATEGORIES)).toEqual(state);
  });

  it('fits the 64-byte limit in the worst case: every category, longest window, all flags', () => {
    const state: ReportState = {
      period: 'bucket',
      count: 24,
      categories: MANY_CATEGORIES,
      oneOff: true,
      currency: 'RUB',
      sort: 'sum',
    };
    for (const encoded of [
      encodeReport(state, MANY_CATEGORIES),
      encodeReportImage(state, MANY_CATEGORIES),
    ]) {
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
      expect(decodeReport(encoded, MANY_CATEGORIES)).toEqual(state);
    }
  });

  it('stays short even with every category selected by name', () => {
    const state: ReportState = { ...DEFAULT_REPORT, categories: CATEGORIES.slice(0, 4) };
    expect(Buffer.byteLength(encodeReport(state, CATEGORIES))).toBeLessThanOrEqual(64);
  });

  it('round-trips the default state', () => {
    expect(decodeReport(encodeReport(DEFAULT_REPORT, CATEGORIES), CATEGORIES)).toEqual(
      DEFAULT_REPORT,
    );
  });

  it('rejects data that is not a report callback', () => {
    expect(decodeReport('d:abcd:save', CATEGORIES)).toBeNull();
    expect(decodeReport('r:w:', CATEGORIES)).toBeNull();
    expect(decodeReport('r:wNaN:-:-', CATEGORIES)).toBeNull();
    expect(decodeReport('r:x8:-:-', CATEGORIES)).toBeNull();
    expect(decodeReport('r:b0:-:-', CATEGORIES)).toBeNull();
  });
});

describe('toggleCategory', () => {
  it('starts from "everything" and removes the tapped one', () => {
    expect(toggleCategory([], 'Food', CATEGORIES)).toEqual([
      'Transport',
      'Housing',
      'Health',
      'Other',
    ]);
  });

  it('adds back to a partial selection', () => {
    expect(toggleCategory(['Food'], 'Housing', CATEGORIES)).toEqual(['Food', 'Housing']);
  });

  it('collapses a full selection back to "no filter"', () => {
    expect(toggleCategory(CATEGORIES.slice(0, 4), 'Other', CATEGORIES)).toEqual([]);
  });

  it('collapses an empty selection back to "no filter"', () => {
    expect(toggleCategory(['Food'], 'Food', CATEGORIES)).toEqual([]);
  });
});

describe('report rendering', () => {
  // Two buckets of September: days 1–8 and 9–16
  const periods = ['2026-09-b1', '2026-09-b2'];
  const txns = [txn('2026-09-01', 10), txn('2026-09-08', 20), txn('2026-09-09', 5, 'Transport')];

  it('puts every category and period into the rich table', () => {
    const rich = renderReportRich(DEFAULT_REPORT, bucketed(txns, periods));

    expect(rich).toContain('<table bordered striped compact>');
    expect(rich).toContain('Еда');
    expect(rich).toContain('Транспорт');
    expect(rich).toContain('1–8 сен');
    expect(rich).toContain('9–16 сен');
    expect(rich).toContain('<tg-button-row>');
  });

  it('splits months into tables of six periods', () => {
    const many = recentPeriods('2026-09-11', 'month', MAX_TABLE_PERIODS + 2);
    const state: ReportState = { ...DEFAULT_REPORT, period: 'month', count: many.length };
    const month = data(
      byCategory(buildMatrix(txns, many, () => true, 'month')),
      many,
      txns,
      'month',
    );

    expect(renderReportRich(state, month).match(/<table /g)).toHaveLength(2);
    expect(splitPeriods(many, 'month').map((slice) => slice.length)).toEqual([6, 2]);
  });

  it('gives each month of buckets its own table of four columns', () => {
    // Eight buckets ending 9–16 October: the tail of August, all of September, the start of October
    const eight = recentPeriods('2026-10-12', 'bucket', 8);
    const rich = renderReportRich({ ...DEFAULT_REPORT, count: 8 }, bucketed(txns, eight));

    expect(splitPeriods(eight, 'bucket')).toEqual([
      ['2026-08-b3', '2026-08-b4'],
      ['2026-09-b1', '2026-09-b2', '2026-09-b3', '2026-09-b4'],
      ['2026-10-b1', '2026-10-b2'],
    ]);
    expect(rich.match(/<table /g)).toHaveLength(3);
  });

  it('says so plainly when there is nothing to show, and keeps the switches', () => {
    const empty = renderReportRich(DEFAULT_REPORT, data([], periods));

    expect(empty).toContain('трат нет');
    expect(empty).toContain('<tg-button-row>');
    expect(empty).not.toContain('<table');
  });

  it('escapes category names into both attributes and text', () => {
    const rows = byCategory(
      buildMatrix([txn('2026-09-08', 10, 'A&B "x"')], periods, () => true, 'bucket'),
    );
    const rich = renderReportRich(DEFAULT_REPORT, {
      ...data(rows, periods),
      allCategories: ['A&B "x"'],
    });

    expect(rich).toContain('A&amp;B &#34;x&#34;');
    // A raw quote would close the data= attribute early and break every button after it
    expect(rich).not.toContain('A&B "x"');
  });

  it('renders the same numbers as a monospace block in the fallback', () => {
    const html = renderReportHtml(DEFAULT_REPORT, bucketed(txns, periods));

    expect(html).toContain('<pre>');
    expect(html).toContain('Еда');
    expect(html).toContain('1–8 сен');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<tg-button');
  });

  it('flags one-off spending that the table deliberately leaves out', () => {
    const rich = renderReportRich(DEFAULT_REPORT, {
      ...bucketed(txns, periods),
      oneOffTotal: 250,
    });

    expect(rich).toContain('Разовые траты за период');
    expect(rich).toContain('250\u00a0₽');
  });
});

describe('report currency', () => {
  const periods = ['2026-09-b1'];
  // $10 is 800 ₽ in the fixture; a thousand separator in ru-RU is a non-breaking space
  const txns = [txn('2026-09-01', 10), txn('2026-09-02', 150)];
  const usd: ReportState = { ...DEFAULT_REPORT, currency: 'USD' };

  function rubles(): ReportData {
    return {
      ...data(byCategory(buildMatrix(txns, periods, () => true, 'bucket', 'rub')), periods),
      totals: periodTotals(txns, periods, () => true, 'bucket', 'rub'),
      oneOffTotal: 24_000,
    };
  }

  it('shows rubles by default and dollars when asked, in tables, bars and notes', () => {
    const rich = renderReportRich(DEFAULT_REPORT, rubles());
    expect(rich).toContain('12\u00a0800\u00a0₽');
    expect(rich).toContain('· RUB');
    expect(rich).toContain('24\u00a0000\u00a0₽');
    expect(rich).not.toMatch(/\$\d/);

    const html = renderReportHtml(DEFAULT_REPORT, rubles());
    expect(html).toContain('12\u00a0800\u00a0₽');
    expect(html).not.toContain('$');

    const dollars = renderReportRich(usd, bucketed(txns, periods));
    expect(dollars).toContain('$160');
    expect(dollars).toContain('· USD');
    // The switch button says «$ в долларах», so look for an amount rather than the sign
    expect(dollars).not.toContain('\u00a0₽');
  });

  it('offers the other currency on a button that keeps the rest of the screen', () => {
    const state: ReportState = { ...DEFAULT_REPORT, oneOff: true, categories: ['Food'] };
    const toUsd = richCallbacks(renderReportRich(state, rubles())).map((d) =>
      decodeReport(d, CATEGORIES),
    );
    expect(toUsd).toContainEqual({ ...state, currency: 'USD' });

    const toRub = richCallbacks(renderReportRich(usd, bucketed(txns, periods))).map((d) =>
      decodeReport(d, CATEGORIES),
    );
    expect(toRub).toContainEqual(DEFAULT_REPORT);
  });
});

describe('report buttons', () => {
  const worst: ReportState = {
    period: 'bucket',
    count: 24,
    categories: MANY_CATEGORIES.slice(0, 5),
    oneOff: true,
    currency: 'RUB',
    sort: 'sum',
  };
  // One row is enough for the table and the category picker to appear
  const wide: ReportData = {
    ...bucketed([txn('2026-09-01', 10, 'Category 1')], ['2026-09-b1']),
    allCategories: MANY_CATEGORIES,
  };

  it('keeps every button of the rich screen inside 64 bytes and decodable', () => {
    const callbacks = richCallbacks(renderReportRich(worst, wide));

    expect(callbacks.length).toBeGreaterThan(MANY_CATEGORIES.length);
    for (const callback of callbacks) {
      expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
      expect(decodeReport(callback, MANY_CATEGORIES)).not.toBeNull();
    }
  });

  it('keeps every button of the plain keyboard inside 64 bytes and decodable', () => {
    const buttons = reportKeyboard(worst, MANY_CATEGORIES).inline_keyboard.flat();

    expect(buttons.length).toBeGreaterThan(MANY_CATEGORIES.length);
    for (const button of buttons) {
      const callback = 'callback_data' in button ? button.callback_data : '';
      expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
      expect(decodeReport(callback, MANY_CATEGORIES)).not.toBeNull();
    }
  });

  it('labels bucket windows in months', () => {
    const labels = reportKeyboard(DEFAULT_REPORT, CATEGORIES)
      .inline_keyboard.flat()
      .map((button) => button.text);

    expect(labels).toEqual(
      expect.arrayContaining(['• Недели', 'Месяцы', '1 мес', '• 2 мес', '3 мес', '6 мес']),
    );
    expect(labels).toContain('$ в долларах');
  });
});

describe('report row order', () => {
  // The fixture sheet lists Income, Food, Transport, Transfer, Misc — in that order
  const today = '2026-09-11';
  const txns = [
    txn('2026-09-01', 10, 'Food'),
    txn('2026-09-02', 50, 'Transport'),
    txn('2026-09-03', 1, 'Misc'),
    // Categories the sheet does not list (any more)
    txn('2026-09-04', 5, 'Zeta'),
    txn('2026-09-05', 30, 'Alpha'),
    txn('2026-09-06', 0, 'Empty'),
  ];
  const categories = (state: ReportState) =>
    buildReportData(txns, ref, today, state).rows.map((row) => row.category);

  it('follows the order of the sheet by default, with unknown categories last, heaviest first', () => {
    expect(DEFAULT_REPORT.sort).toBe('category');
    expect(categories(DEFAULT_REPORT)).toEqual(['Food', 'Transport', 'Misc', 'Alpha', 'Zeta']);
  });

  it('puts the heaviest first when sorted by sum', () => {
    expect(categories({ ...DEFAULT_REPORT, sort: 'sum' })).toEqual([
      'Transport',
      'Alpha',
      'Food',
      'Zeta',
      'Misc',
    ]);
  });

  it('drops categories nothing was spent on, in both orders', () => {
    for (const sort of ['category', 'sum'] as const) {
      expect(categories({ ...DEFAULT_REPORT, sort })).not.toContain('Empty');
    }
  });

  it('keeps the chosen categories in the sheet order whatever order they were picked in', () => {
    expect(categories({ ...DEFAULT_REPORT, categories: ['Misc', 'Transport'] })).toEqual([
      'Transport',
      'Misc',
    ]);
  });

  it('does not change the totals, only the order of the rows', () => {
    const byCategory = buildReportData(txns, ref, today, DEFAULT_REPORT);
    const bySum = buildReportData(txns, ref, today, { ...DEFAULT_REPORT, sort: 'sum' });

    expect(bySum.totals).toEqual(byCategory.totals);
    expect(bySum.oneOffTotal).toBe(byCategory.oneOffTotal);
    expect([...bySum.rows].sort((a, b) => a.total - b.total)).toEqual(
      [...byCategory.rows].sort((a, b) => a.total - b.total),
    );
  });
});

describe('report sort switch', () => {
  const periods = ['2026-09-b1'];
  const data = { ...bucketed([txn('2026-09-01', 10)], periods), allCategories: CATEGORIES };
  const bySum: ReportState = { ...DEFAULT_REPORT, sort: 'sum' };

  it('names where the switch leads', () => {
    expect(sortLabel(DEFAULT_REPORT)).toBe('↕ по сумме');
    expect(sortLabel(bySum)).toBe('↕ по категориям');
    expect(otherSort(DEFAULT_REPORT)).toBe('sum');
    expect(otherSort(bySum)).toBe('category');
  });

  it('sits in the switches row of the rich screen and flips only the sort', () => {
    const state: ReportState = { ...DEFAULT_REPORT, oneOff: true, categories: ['Food'] };
    const rich = renderReportRich(state, data);

    expect(rich).toContain('↕ по сумме');
    // After the one-off and currency switches, in the same row
    expect(rich).toMatch(
      /− разовые<\/tg-button><tg-button[^>]*>\$ в долларах<\/tg-button><tg-button[^>]*>↕ по сумме<\/tg-button><\/tg-button-row>/,
    );
    expect(richCallbacks(rich).map((d) => decodeReport(d, CATEGORIES))).toContainEqual({
      ...state,
      sort: 'sum',
    });
    expect(renderReportRich(bySum, data)).toContain('↕ по категориям');
  });

  it('sits in the switches row of the plain keyboard and flips only the sort', () => {
    const state: ReportState = { ...DEFAULT_REPORT, oneOff: true, categories: ['Food'] };
    const rows = reportKeyboard(state, CATEGORIES).inline_keyboard;
    const row = rows.find((buttons) => buttons.some((button) => button.text === '↕ по сумме'));

    expect(row?.map((button) => button.text)).toEqual(['− разовые', '$ в долларах', '↕ по сумме']);
    const sort = row?.at(-1);
    expect(decodeReport('callback_data' in sort! ? sort.callback_data : '', CATEGORIES)).toEqual({
      ...state,
      sort: 'sum',
    });
  });
});

describe('report category names', () => {
  const periods = ['2026-09-b1'];
  const txns = [txn('2026-09-01', 10, 'Food'), txn('2026-09-02', 5, 'Housing')];
  const data = { ...bucketed(txns, periods), allCategories: CATEGORIES };

  it('shows Russian names in the rich table, the picker and the fallback', () => {
    const rich = renderReportRich(DEFAULT_REPORT, data);
    expect(rich).toContain('<td align="left">Еда</td>');
    expect(rich).toContain('<td align="left">Жильё</td>');
    expect(rich).toContain('☑ Еда');
    expect(rich).toContain('☑ Здоровье');
    expect(rich).not.toContain('>Food<');
    expect(rich).not.toContain('Housing');

    const html = renderReportHtml(DEFAULT_REPORT, data);
    expect(html).toContain('Еда');
    expect(html).toContain('Жильё');
    expect(html).not.toContain('Food');
  });

  it('shows them on the plain keyboard too', () => {
    const labels = reportKeyboard(DEFAULT_REPORT, CATEGORIES)
      .inline_keyboard.flat()
      .map((button) => button.text);

    expect(labels).toEqual(expect.arrayContaining(['☑ Еда', '☑ Транспорт', '☑ Прочее']));
    expect(labels).not.toContain('☑ Food');
  });

  it('keeps the masks on the sheet names, so a tap still picks the right category', () => {
    const rich = richCallbacks(renderReportRich(DEFAULT_REPORT, data)).map((d) =>
      decodeReport(d, CATEGORIES),
    );
    // Tapping «Еда» in the picker leaves everything but Food
    expect(rich).toContainEqual({
      ...DEFAULT_REPORT,
      categories: ['Transport', 'Housing', 'Health', 'Other'],
    });

    const plain = reportKeyboard(DEFAULT_REPORT, CATEGORIES).inline_keyboard.flat();
    const food = plain.find((button) => button.text === '☑ Еда');
    expect(decodeReport('callback_data' in food! ? food.callback_data : '', CATEGORIES)).toEqual({
      ...DEFAULT_REPORT,
      categories: ['Transport', 'Housing', 'Health', 'Other'],
    });
  });

  it('keeps the name of a category it has no translation for', () => {
    const rows = byCategory(
      buildMatrix([txn('2026-09-08', 10, 'Gadgets')], periods, () => true, 'bucket'),
    );

    expect(renderReportRich(DEFAULT_REPORT, { ...data, rows })).toContain('>Gadgets<');
  });
});

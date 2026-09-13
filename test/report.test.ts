import { describe, expect, it } from 'vitest';
import { buildMatrix, byCategory, periodTotals, type MatrixRow } from '../src/analytics/queries.js';
import type { Txn } from '../src/analytics/dataset.js';
import {
  decodeReport,
  DEFAULT_REPORT,
  encodeReport,
  MAX_TABLE_PERIODS,
  renderReportHtml,
  renderReportRich,
  toggleCategory,
  type ReportData,
  type ReportState,
} from '../src/domain/report.js';

const CATEGORIES = ['Food', 'Transport', 'Housing', 'Health', 'Other'];

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
    category,
    subcategory: '',
    comment: '',
    oneOff: false,
  };
}

function data(rows: MatrixRow[], periods: string[], txns: Txn[] = []): ReportData {
  return {
    rows,
    totals: periodTotals(txns, periods, () => true, 'week'),
    periods,
    allCategories: CATEGORIES,
    oneOffTotal: 0,
  };
}

function weekly(txns: Txn[], periods: string[]): ReportData {
  return data(byCategory(buildMatrix(txns, periods, () => true, 'week')), periods, txns);
}

describe('report callback codec', () => {
  it('round-trips a state through the 64-byte callback budget', () => {
    const state: ReportState = {
      period: 'month',
      count: 12,
      categories: ['Food', 'Housing'],
      oneOff: true,
    };
    const encoded = encodeReport(state, CATEGORIES);

    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
    expect(decodeReport(encoded, CATEGORIES)).toEqual(state);
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
  const periods = ['2026-W36', '2026-W37'];
  const txns = [txn('2026-09-01', 10), txn('2026-09-08', 20), txn('2026-09-09', 5, 'Transport')];

  it('puts every category and period into the rich table', () => {
    const rich = renderReportRich(DEFAULT_REPORT, weekly(txns, periods));

    expect(rich).toContain('<table bordered striped compact>');
    expect(rich).toContain('Food');
    expect(rich).toContain('Transport');
    expect(rich).toContain('31.08–06.09');
    expect(rich).toContain('<tg-button-row>');
  });

  it('splits a wide matrix into several tables instead of one unreadable one', () => {
    const many = Array.from({ length: MAX_TABLE_PERIODS + 2 }, (_, i) => `2026-W${30 + i}`);
    const rich = renderReportRich({ ...DEFAULT_REPORT, count: many.length }, weekly(txns, many));

    expect(rich.match(/<table /g)).toHaveLength(2);
  });

  it('says so plainly when there is nothing to show, and keeps the switches', () => {
    const empty = renderReportRich(DEFAULT_REPORT, data([], periods));

    expect(empty).toContain('трат нет');
    expect(empty).toContain('<tg-button-row>');
    expect(empty).not.toContain('<table');
  });

  it('escapes category names into both attributes and text', () => {
    const rows = byCategory(
      buildMatrix([txn('2026-09-08', 10, 'A&B "x"')], periods, () => true, 'week'),
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
    const html = renderReportHtml(DEFAULT_REPORT, weekly(txns, periods));

    expect(html).toContain('<pre>');
    expect(html).toContain('Food');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<tg-button');
  });

  it('flags one-off spending that the table deliberately leaves out', () => {
    const rich = renderReportRich(DEFAULT_REPORT, {
      ...weekly(txns, periods),
      oneOffTotal: 250,
    });

    expect(rich).toContain('Разовые траты за период');
    expect(rich).toContain('$250');
  });
});

import type { sheets_v4 } from 'googleapis';
import {
  CAPITAL_COLUMNS,
  CAPITAL_ROW_COUNT,
  CAPITAL_SHEET,
  COL,
  LAST_VISIBLE,
  ROWS,
  STEPS,
} from './capital-layout.js';

type Request = sheets_v4.Schema$Request;
type GridRange = sheets_v4.Schema$GridRange;
type CellFormat = sheets_v4.Schema$CellFormat;

const COLORS = {
  header: '#f1f3f5',
  input: '#fff3bf',
  muted: '#868e96',
  up: '#d3f9d8',
  upText: '#2b8a3e',
  down: '#ffe3e3',
  downText: '#c92a2a',
  capital: '#1c7ed6',
  savings: '#37b24d',
};
const MONEY = '#,##0';
const DELTA = '"+"#,##0;"−"#,##0;0';
const SUMMARY_DELTA = '"▲ +"#,##0;"▼ −"#,##0;0';
const PERCENT = '"+"0.0%;"−"0.0%;0%';
const CHART_HEIGHT = 320;
const CHART_WIDTH = 760;

function rgb(hex: string): sheets_v4.Schema$Color {
  const channel = (from: number) => parseInt(hex.slice(from, from + 2), 16) / 255;
  return { red: channel(1), green: channel(3), blue: channel(5) };
}

/** 1-based inclusive rows, 0-based inclusive columns; `lastRow` null = to the end of the sheet. */
function cells(sheetId: number, rows: [number, number | null], cols: [number, number]): GridRange {
  return {
    sheetId,
    startRowIndex: rows[0] - 1,
    ...(rows[1] === null ? {} : { endRowIndex: rows[1] }),
    startColumnIndex: cols[0],
    endColumnIndex: cols[1] + 1,
  };
}

function repeat(range: GridRange, format: CellFormat, fields: string): Request {
  return {
    repeatCell: {
      range,
      cell: { userEnteredFormat: format },
      fields: `userEnteredFormat(${fields})`,
    },
  };
}

const number = (pattern: string): CellFormat => ({ numberFormat: { type: 'NUMBER', pattern } });

/** Creates the sheet right after «Дашборд» (or last), wide enough for the hidden matrix. */
export function addCapitalSheet(index?: number): Request {
  return {
    addSheet: {
      properties: {
        title: CAPITAL_SHEET,
        index,
        gridProperties: {
          rowCount: CAPITAL_ROW_COUNT,
          columnCount: CAPITAL_COLUMNS,
          frozenColumnCount: 1,
        },
      },
    },
  };
}

function layoutRequests(sheetId: number): Request[] {
  const width = (start: number, end: number, pixelSize: number): Request => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: end },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  });
  return [
    width(COL.label, COL.label + 1, 110),
    // «За месяц (с 17.10)» and «Сбережения, USD» are the widest headers
    width(COL.capital, COL.firstGroup, 135),
    width(COL.firstGroup, LAST_VISIBLE + 1, 105),
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: COL.helper, endIndex: CAPITAL_COLUMNS },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
  ];
}

const HEADER_FORMAT: CellFormat = {
  backgroundColor: rgb(COLORS.header),
  textFormat: { bold: true },
  horizontalAlignment: 'CENTER',
};

/** Title, controls and the summary block above the chart. */
function styleRequests(sheetId: number): Request[] {
  const header = HEADER_FORMAT;
  const summaryCols: [number, number] = [COL.label, COL.savingsDelta + 1];
  return [
    repeat(
      cells(sheetId, [ROWS.title, ROWS.title], [0, 0]),
      { textFormat: { bold: true, fontSize: 14 } },
      'textFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.title, ROWS.title], [COL.capitalDelta, COL.capitalDelta]),
      { textFormat: { italic: true, foregroundColor: rgb(COLORS.muted) } },
      'textFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.currency, ROWS.step], [COL.capital, COL.capital]),
      { backgroundColor: rgb(COLORS.input), horizontalAlignment: 'CENTER' },
      'backgroundColor,horizontalAlignment',
    ),
    repeat(
      cells(sheetId, [ROWS.summaryHeader, ROWS.summaryHeader], summaryCols),
      header,
      'backgroundColor,textFormat,horizontalAlignment',
    ),
    repeat(
      cells(sheetId, [ROWS.capital, ROWS.savings], [0, 0]),
      { textFormat: { bold: true } },
      'textFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.capital, ROWS.savings], [COL.capital, COL.capital]),
      { ...number(MONEY), textFormat: { bold: true } },
      'numberFormat,textFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.capital, ROWS.savings], [2, 2]),
      number(SUMMARY_DELTA),
      'numberFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.capital, ROWS.savings], [4, 4]),
      number(SUMMARY_DELTA),
      'numberFormat',
    ),
    repeat(cells(sheetId, [ROWS.capital, ROWS.savings], [3, 3]), number(PERCENT), 'numberFormat'),
    repeat(cells(sheetId, [ROWS.capital, ROWS.savings], [5, 5]), number(PERCENT), 'numberFormat'),
  ];
}

/** The table under the chart: header, money, signed Δ, bold totals. */
function tableStyleRequests(sheetId: number): Request[] {
  return [
    repeat(
      cells(sheetId, [ROWS.header, ROWS.header], [COL.label, LAST_VISIBLE]),
      HEADER_FORMAT,
      'backgroundColor,textFormat,horizontalAlignment',
    ),
    repeat(
      cells(sheetId, [ROWS.first, null], [COL.capital, LAST_VISIBLE]),
      number(MONEY),
      'numberFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.first, null], [COL.capitalDelta, COL.capitalDelta]),
      number(DELTA),
      'numberFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.first, null], [COL.savingsDelta, COL.savingsDelta]),
      number(DELTA),
      'numberFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.first, null], [COL.capital, COL.capital]),
      { textFormat: { bold: true } },
      'textFormat',
    ),
    repeat(
      cells(sheetId, [ROWS.first, null], [COL.savings, COL.savings]),
      { textFormat: { bold: true } },
      'textFormat',
    ),
  ];
}

function listRule(sheetId: number, row: number, options: readonly string[]): Request {
  return {
    setDataValidation: {
      range: cells(sheetId, [row, row], [COL.capital, COL.capital]),
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: options.map((userEnteredValue) => ({ userEnteredValue })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  };
}

function validationRequests(sheetId: number): Request[] {
  return [listRule(sheetId, ROWS.currency, ['USD', 'RUB']), listRule(sheetId, ROWS.step, STEPS)];
}

/** Growth green, decline red: on the summary deltas and on both Δ columns of the table. */
function conditionalRequests(sheetId: number): Request[] {
  const ranges = [
    cells(sheetId, [ROWS.capital, ROWS.savings], [COL.capitalDelta, COL.savingsDelta + 1]),
    cells(sheetId, [ROWS.first, null], [COL.capitalDelta, COL.capitalDelta]),
    cells(sheetId, [ROWS.first, null], [COL.savingsDelta, COL.savingsDelta]),
  ];
  const rule = (type: string, background: string, text: string, index: number): Request => ({
    addConditionalFormatRule: {
      index,
      rule: {
        ranges,
        booleanRule: {
          condition: { type, values: [{ userEnteredValue: '0' }] },
          format: { backgroundColor: rgb(background), textFormat: { foregroundColor: rgb(text) } },
        },
      },
    },
  });
  return [
    rule('NUMBER_GREATER', COLORS.up, COLORS.upText, 0),
    rule('NUMBER_LESS', COLORS.down, COLORS.downText, 1),
  ];
}

function chartRequest(sheetId: number): Request {
  const source = (col: number) => ({
    sourceRange: { sources: [cells(sheetId, [ROWS.header, CAPITAL_ROW_COUNT], [col, col])] },
  });
  const series = (col: number, color: string) => ({
    series: source(col),
    targetAxis: 'LEFT_AXIS',
    color: rgb(color),
    lineStyle: { width: 3 },
  });
  return {
    addChart: {
      chart: {
        spec: {
          title: 'Капитал и сбережения',
          basicChart: {
            chartType: 'LINE',
            legendPosition: 'BOTTOM_LEGEND',
            headerCount: 1,
            domains: [{ domain: source(COL.label) }],
            series: [series(COL.capital, COLORS.capital), series(COL.savings, COLORS.savings)],
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId, rowIndex: ROWS.chart - 1, columnIndex: COL.label },
            widthPixels: CHART_WIDTH,
            heightPixels: CHART_HEIGHT,
          },
        },
      },
    },
  };
}

/** Only B2 is meant to be edited; everything else is formulas, so edits only warn. */
function protectionRequest(sheetId: number): Request {
  return {
    addProtectedRange: {
      protectedRange: {
        range: { sheetId },
        description: '«Капитал»: только формулы, меняются лишь валюта и шаг в B2:B3',
        warningOnly: true,
        unprotectedRanges: [cells(sheetId, [ROWS.currency, ROWS.step], [COL.capital, COL.capital])],
      },
    },
  };
}

/** Everything that styles «Капитал» once the values are in; no values are touched. */
export function capitalFormatRequests(sheetId: number): Request[] {
  return [
    ...layoutRequests(sheetId),
    ...styleRequests(sheetId),
    ...tableStyleRequests(sheetId),
    ...validationRequests(sheetId),
    ...conditionalRequests(sheetId),
    chartRequest(sheetId),
    protectionRequest(sheetId),
  ];
}

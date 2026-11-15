import type { sheets_v4 } from 'googleapis';
import {
  CAPITAL_SHEET,
  capitalFormula,
  COL,
  cutoffsFormula,
  deltaFormula,
  GROUP_COLUMNS,
  groupFormula,
  HELPER_ROWS,
  helperFormulas,
  labelFormula,
  matrixFormula,
  META_ROWS,
  metaFormulas,
  MONTH_AGO_ROW,
  monthAgoBalancesFormula,
  monthAgoExpressions,
  ROWS,
  savingsFormula,
  STEPS,
  type CapitalInput,
} from './capital-layout.js';
import { columnLetter as L } from './weeks-layout.js';

type ValueRange = sheets_v4.Schema$ValueRange;

const at = (col: number, row: number) => `'${CAPITAL_SHEET}'!${L(col)}${row}`;
const one = (col: number, row: number, value: string): ValueRange => ({
  range: at(col, row),
  values: [[value]],
});
const ref = (col: number, row: number) => `$${L(col)}$${row}`;
const START = ref(COL.helper, HELPER_ROWS.start);

function summaryRow(label: string, row: number, valueCol: number, monthAgo: string): ValueRange {
  const values = `$${L(valueCol)}$${ROWS.first}:$${L(valueCol)}`;
  const now = `B${row}`;
  const first = `$${L(valueCol)}$${ROWS.first}`;
  return {
    range: `'${CAPITAL_SHEET}'!A${row}:F${row}`,
    values: [
      [
        label,
        `=INDEX(${values},${ref(COL.helper, HELPER_ROWS.count)})`,
        `=${now}-${monthAgo}`,
        `=IFERROR(C${row}/(${now}-C${row}),"")`,
        `=${now}-${first}`,
        `=IFERROR(E${row}/${first},"")`,
      ],
    ],
  };
}

function headerRow(): ValueRange {
  const titles = [
    'Дата',
    `="Капитал, "&$B$${ROWS.currency}`,
    'Δ',
    `="Сбережения, "&$B$${ROWS.currency}`,
    'Δ',
    ...GROUP_COLUMNS,
  ];
  return { range: at(COL.label, ROWS.header), values: [titles] };
}

function helperValues(input: CapitalInput): ValueRange[] {
  const helpers = helperFormulas(input.rubRow);
  const meta = metaFormulas(input);
  return [
    one(COL.helper, 1, 'служебное'),
    ...Object.entries(HELPER_ROWS).map(([key, row]) =>
      one(COL.helper, row, helpers[key as keyof typeof HELPER_ROWS]),
    ),
    one(COL.helper, ROWS.header, 'Срез'),
    one(COL.helper, ROWS.first, cutoffsFormula()),
    one(COL.matrix, 1, 'Счета капитала (служебное): ID, группа, начальный остаток, дата, курс'),
    ...Object.entries(META_ROWS).map(([key, row]) =>
      one(COL.matrix, row, meta[key as keyof typeof META_ROWS]),
    ),
    one(COL.matrix, MONTH_AGO_ROW, monthAgoBalancesFormula(input)),
    one(COL.matrix, ROWS.first, matrixFormula(input)),
  ];
}

/** Every label and formula of «Капитал», as ranges for one values.batchUpdate. */
export function capitalValues(input: CapitalInput): ValueRange[] {
  const monthAgo = monthAgoExpressions();
  return [
    one(COL.label, ROWS.title, 'Капитал и сбережения'),
    one(
      COL.capitalDelta,
      ROWS.title,
      `="по текущим курсам (лист Курсы) · остатки известны с "&TEXT(${START},"dd.mm.yyyy")`,
    ),
    {
      range: `'${CAPITAL_SHEET}'!A${ROWS.currency}:B${ROWS.step}`,
      values: [
        ['Валюта', 'USD'],
        ['Шаг', STEPS[0]],
      ],
    },
    {
      range: `'${CAPITAL_SHEET}'!B${ROWS.summaryHeader}:F${ROWS.summaryHeader}`,
      values: [
        [
          `="Сейчас, "&$B$${ROWS.currency}`,
          `="За месяц (с "&TEXT(${ref(COL.helper, HELPER_ROWS.monthAgo)},"dd.mm")&")"`,
          '%',
          `="С "&TEXT(${START},"dd.mm.yy")`,
          '%',
        ],
      ],
    },
    summaryRow('Капитал', ROWS.capital, COL.capital, monthAgo.capital),
    summaryRow('Сбережения', ROWS.savings, COL.savings, monthAgo.savings),
    headerRow(),
    one(COL.label, ROWS.first, labelFormula()),
    one(COL.capital, ROWS.first, capitalFormula()),
    one(COL.capitalDelta, ROWS.first + 1, deltaFormula(COL.capital)),
    one(COL.savings, ROWS.first, savingsFormula()),
    one(COL.savingsDelta, ROWS.first + 1, deltaFormula(COL.savings)),
    ...GROUP_COLUMNS.map((_, i) =>
      one(COL.firstGroup + i, ROWS.first, groupFormula(COL.firstGroup + i)),
    ),
    ...helperValues(input),
  ];
}

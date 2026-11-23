import type { sheets_v4 } from 'googleapis';
import { columnLetter } from './weeks-layout.js';

/**
 * Hidden «_Подкатегории»: row N holds the subcategories of the category written in
 * «Операции» row N, so the H dropdown can point at its own row (docs/SHEET_V2.md §4).
 */
export const SUBS_SHEET = '_Подкатегории';
const MIN_ROWS = 6000;
const MIN_COLS = 20;
const COLS_MARGIN = 10;
const WARN_SHARE = 0.8;

/** INDEX(...,ROW()) rather than G2: it survives row inserts, deletes and sorting in «Операции». */
export const SUBS_FORMULA =
  `=IF(INDEX('Операции'!$G:$G,ROW())="","",IFERROR(TRANSPOSE(FILTER(Categories!$B$2:$B$300,` +
  `Categories!$A$2:$A$300=INDEX('Операции'!$G:$G,ROW()),Categories!$B$2:$B$300<>"")),""))`;

export const SUBS_NOTE =
  'Служебное: строка N — подкатегории категории из «Операции»!G(N). Не редактировать (yarn settlements-sheet).';

export const subsRows = (operationsRows: number, existing = 0): number =>
  Math.max(MIN_ROWS, operationsRows * 2, existing);

export const subsColumns = (longestList: number): number =>
  Math.max(MIN_COLS, longestList + COLS_MARGIN);

/** Relative row, absolute columns: Sheets reads it against the top-left cell of the range. */
export const subsRangeFormula = (columns: number, row = 2): string =>
  `='${SUBS_SHEET}'!$A${row}:$${columnLetter(columns - 1)}${row}`;

export function subsRule(columns: number): sheets_v4.Schema$DataValidationRule {
  return {
    condition: {
      type: 'ONE_OF_RANGE',
      values: [{ userEnteredValue: subsRangeFormula(columns) }],
    },
    strict: false,
    showCustomUi: true,
  };
}

/** Whether the rule of every row of H (index 0 = row 2) points at that row's own line. */
export function ruleProblems(
  rules: Array<sheets_v4.Schema$DataValidationRule | null | undefined>,
  columns: number,
) {
  const problems: string[] = [];
  rules.forEach((rule, i) => {
    const want = subsRangeFormula(columns, i + 2);
    const got = rule?.condition?.values?.[0]?.userEnteredValue ?? '';
    if (rule?.condition?.type !== 'ONE_OF_RANGE' || got !== want) {
      problems.push(`H${i + 2}: ${got || 'нет правила'} (ожидалось ${want})`);
    }
  });
  return problems;
}

/** A warning when «Операции» is close to the rows «_Подкатегории» covers; null while there is room. */
export function capacityWarning(used: number, capacity: number): string | null {
  if (used < capacity * WARN_SHARE) return null;
  return (
    `«Операции»: заполнено ${used} строк из ${capacity}, которые покрывает «${SUBS_SHEET}» — ` +
    'за пределами выпадающий список подкатегорий пуст. Продли: yarn settlements-sheet --apply'
  );
}

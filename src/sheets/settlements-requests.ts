import type { sheets_v4 } from 'googleapis';
import {
  categoryFormula,
  type CategoriesPlan,
  type ListRulePlan,
  type NewAccount,
} from './settlements-plan.js';

type Request = sheets_v4.Schema$Request;
type Cell = sheets_v4.Schema$CellData;

const str = (value: string): Cell => ({ userEnteredValue: { stringValue: value } });
const formula = (value: string): Cell => ({ userEnteredValue: { formulaValue: value } });
const cell = (value: string | number | boolean): Cell =>
  typeof value === 'string'
    ? str(value)
    : typeof value === 'number'
      ? { userEnteredValue: { numberValue: value } }
      : { userEnteredValue: { boolValue: value } };

function put(sheetId: number, row: number, col: number, rows: Cell[][]): Request {
  return {
    updateCells: {
      start: { sheetId, rowIndex: row, columnIndex: col },
      rows: rows.map((values) => ({ values })),
      fields: 'userEnteredValue',
    },
  };
}

/** Columns first, so everything below addresses the shifted «CategoryList». */
export function categoriesRequests(sheetId: number, plan: CategoriesPlan): Request[] {
  const requests: Request[] = [];
  const [from, to] = plan.formulaCols;
  if (plan.insertColumns > 0) {
    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: plan.listCol,
          endIndex: plan.listCol + plan.insertColumns,
        },
        inheritFromBefore: true,
      },
    });
  }
  if (plan.newPairs.length > 0) {
    requests.push(
      put(
        sheetId,
        plan.firstFreeRow - 1,
        0,
        plan.newPairs.map(([c, s]) => [str(c), str(s)]),
      ),
    );
  }
  if (plan.rewriteFormulas) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 2, startColumnIndex: from, endColumnIndex: to },
        cell: {},
        fields: 'userEnteredValue',
      },
    });
    const cols = Array.from({ length: to - from }, (_, i) => formula(categoryFormula(from + i)));
    requests.push(put(sheetId, 1, from, [cols]));
  }
  if (plan.listAppend.names.length > 0) {
    const col = plan.formulaCols[1];
    requests.push(
      put(
        sheetId,
        plan.listAppend.row - 1,
        col,
        plan.listAppend.names.map((n) => [str(n)]),
      ),
    );
  }
  return requests;
}

export function accountRequests(
  sheetId: number,
  plan: Array<{ row: number; account: NewAccount }>,
): Request[] {
  // J:K hold formulas, so only A:I and L are written
  return plan.flatMap(({ row, account }) => [
    put(sheetId, row - 1, 0, [account.values.map(cell)]),
    put(sheetId, row - 1, 11, [[str(account.note)]]),
  ]);
}

export function listRuleRequest(sheetId: number, col: number, plan: ListRulePlan): Request {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: plan.startRow,
        endRowIndex: plan.endRow,
        startColumnIndex: col,
        endColumnIndex: col + 1,
      },
      rule: plan.rule,
    },
  };
}

/** A new row before `index`, formulas copied from the row above, label in column A. */
export function insertRowRequests(sheetId: number, index: number, width: number, label: string) {
  const row = (r: number) => ({ sheetId, startRowIndex: r, endRowIndex: r + 1 });
  return [
    {
      insertDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 },
        inheritFromBefore: true,
      },
    },
    {
      copyPaste: {
        source: { ...row(index - 1), startColumnIndex: 0, endColumnIndex: width },
        destination: { ...row(index), startColumnIndex: 0, endColumnIndex: width },
        pasteType: 'PASTE_NORMAL',
      },
    },
    put(sheetId, index, 0, [[str(label)]]),
  ] satisfies Request[];
}

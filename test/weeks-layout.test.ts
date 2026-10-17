import { describe, expect, it } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import { categoryLabel } from '../src/domain/category-labels.js';
import type { Category } from '../src/domain/reference.js';
import {
  addSheetRequests,
  buildWeeksLayout,
  checkWeeks,
  columnLetter,
  expenseCategories,
  findColumns,
  helperFormula,
  helperRowCount,
  sampleFormulas,
  uncoveredSubcategories,
  weeksRequests,
  type OperationColumns,
  type WeeksLayout,
} from '../src/sheets/weeks-layout.js';

// «Операции»!A1:K1 is the same before and after the migration; the rest differs
const INPUT_HEADERS = [
  'Дата',
  'Тип',
  'Счёт',
  'Сумма',
  'Счёт куда',
  'Получено',
  'Категория',
  'Подкатегория',
  'Комментарий',
  'Разовая',
  'Курс (ручной)',
];
const BEFORE_MIGRATION = [
  ...INPUT_HEADERS,
  'Валюта',
  'Курс',
  'Сумма USD',
  'Валюта получ.',
  'Курс получ.',
  'Получено USD',
  'Потеря на обмене USD',
  'Получено (расч.)',
  'Месяц',
];
const AFTER_MIGRATION = [
  ...INPUT_HEADERS,
  'Добавлено',
  'Валюта',
  'Курс',
  'Сумма USD',
  'Валюта получ.',
  'Курс получ.',
  'Получено USD',
  'Потеря на обмене USD',
  'Получено (расч.)',
  'Месяц',
];

const CATEGORIES: Category[] = [
  { name: 'Income', subcategories: ['Salary'] },
  { name: 'Housing', subcategories: ['Rent', 'Utilities'] },
  { name: 'Food', subcategories: ['Groceries', 'Cafes & coffee', 'Restaurants'] },
  { name: 'Liza', subcategories: [] },
  { name: 'Transfer', subcategories: ['Between accounts'] },
  { name: 'Other', subcategories: ['Misc'] },
];

function columnsOf(header: string[]): OperationColumns {
  const found = findColumns(header);
  if (!found.ok) throw new Error(`missing: ${found.missing.join(', ')}`);
  return found.columns;
}

function layoutOf(categories: Category[] = CATEGORIES, header = BEFORE_MIGRATION): WeeksLayout {
  return buildWeeksLayout({ categories, columns: columnsOf(header), rubRow: 5 });
}

/** Cell of the «Недели» values by A1 address, e.g. `cell(layout, 'D14')`. */
function cell(layout: WeeksLayout, address: string): unknown {
  const [, letters = '', digits = ''] = /^([A-Z]+)(\d+)$/.exec(address) ?? [];
  const col = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return layout.weeks.values[Number(digits) - 1]?.[col];
}

function ofType<K extends keyof sheets_v4.Schema$Request>(
  requests: sheets_v4.Schema$Request[],
  key: K,
): NonNullable<sheets_v4.Schema$Request[K]>[] {
  return requests.flatMap((request) => (request[key] ? [request[key] as never] : []));
}

describe('categoryLabel', () => {
  it('translates known categories and keeps unknown ones', () => {
    expect(categoryLabel('Food')).toBe('Еда');
    expect(categoryLabel('Liza')).toBe('Лиза');
    expect(categoryLabel('Pets')).toBe('Pets');
    expect(categoryLabel('constructor')).toBe('constructor');
  });
});

describe('columnLetter', () => {
  it('counts like the sheet does', () => {
    expect([0, 25, 26, 32, 35, 701, 702].map(columnLetter)).toEqual([
      'A',
      'Z',
      'AA',
      'AG',
      'AJ',
      'ZZ',
      'AAA',
    ]);
  });
});

describe('findColumns', () => {
  it('finds the columns of the live sheet before the migration (Валюта in L)', () => {
    expect(columnsOf(BEFORE_MIGRATION)).toEqual({
      date: 'A',
      type: 'B',
      amount: 'D',
      category: 'G',
      subcategory: 'H',
      oneOff: 'J',
      currency: 'L',
      usd: 'N',
    });
  });

  it('finds them after the migration (Добавлено in L shifts the rest by one)', () => {
    expect(columnsOf(AFTER_MIGRATION)).toMatchObject({ amount: 'D', currency: 'M', usd: 'O' });
  });

  it('matches names loosely: case, ё, extra spaces', () => {
    const header = [...BEFORE_MIGRATION];
    header[1] = ' ТИП ';
    header[13] = 'сумма   usd';
    expect(columnsOf(header)).toMatchObject({ type: 'B', usd: 'N' });
  });

  it('does not take «Валюта получ.» for «Валюта»', () => {
    const header = [...INPUT_HEADERS, 'Валюта получ.', 'Валюта', 'Сумма USD'];
    expect(columnsOf(header).currency).toBe('M');
  });

  it('lists the missing headers instead of guessing', () => {
    const header = BEFORE_MIGRATION.filter((name) => name !== 'Сумма USD' && name !== 'Разовая');
    expect(findColumns(header)).toEqual({ ok: false, missing: ['Разовая', 'Сумма USD'] });
    expect(findColumns([])).toMatchObject({ ok: false });
  });
});

describe('expenseCategories', () => {
  it('drops income and transfers, keeps the order of «Categories»', () => {
    expect(expenseCategories(CATEGORIES).map((c) => c.name)).toEqual([
      'Housing',
      'Food',
      'Liza',
      'Other',
    ]);
  });
});

describe('helper sheet', () => {
  it('reads the operations by the found letters', () => {
    const before = helperFormula(columnsOf(BEFORE_MIGRATION), 5);
    expect(before).toContain("curs,'Операции'!$L$2:$L");
    expect(before).toContain("usds,'Операции'!$N$2:$N");

    const after = helperFormula(columnsOf(AFTER_MIGRATION), 5);
    expect(after).toContain("curs,'Операции'!$M$2:$M");
    expect(after).toContain("usds,'Операции'!$O$2:$O");
  });

  it('converts with the daily rate and falls back to the current one of the RUB row', () => {
    const formula = helperFormula(columnsOf(BEFORE_MIGRATION), 7);
    expect(formula).toContain(
      "rubs,IF(curs=\"RUB\",sums,usds*IFERROR(VLOOKUP(dayInt,'Курсы'!$H$4:$I,2,TRUE),'Курсы'!$E$7))",
    );
  });

  it('picks the currency and one-offs from the controls and buckets by day', () => {
    const formula = helperFormula(columnsOf(BEFORE_MIGRATION), 5);
    expect(formula).toContain(
      "amounts,IF('Недели'!$B$2=\"RUB\",rubs,usds)*(1-oneOff*NOT('Недели'!$B$3))",
    );
    expect(formula).toContain('oneOff,(once=TRUE)*(types="Расход")');
    expect(formula).toContain('DATE(YEAR(dayInt),MONTH(dayInt),1+8*INT((DAY(dayInt)-1)/8))');
    expect(formula).toContain('ISNUMBER(dates)*((types="Расход")+(types="Доход"))*ISNUMBER(usds)');
  });

  it('is one formula under the headers', () => {
    const { helper } = layoutOf();
    expect(helper.range).toBe("'_Недели'!A1:J2");
    expect(helper.values[0]).toEqual([
      'Дата',
      'Тип',
      'Категория',
      'Подкатегория',
      'Разовая',
      'USD',
      'RUB',
      'Сумма',
      'Неделя',
      'Месяц',
    ]);
    expect(String(helper.values[1]?.[0]).startsWith('=ARRAYFORMULA(')).toBe(true);
    expect(helper.values[1]?.slice(1).every((v) => v === '')).toBe(true);
  });

  it('keeps room for twice the operations, at least 6000 rows', () => {
    expect(helperRowCount(2998)).toBe(6000);
    expect(helperRowCount(4000)).toBe(8000);
  });
});

describe('row plan', () => {
  const layout = layoutOf();

  it('puts totals on rows 9–11 and the categories from row 13, skipping income and transfers', () => {
    expect(layout.rows.map((r) => `${r.row}:${r.kind}`)).toEqual([
      '9:in',
      '10:out',
      '11:sav',
      '13:cat',
      '14:sub',
      '15:sub',
      '16:rest',
      '17:cat',
      '18:sub',
      '19:sub',
      '20:sub',
      '21:rest',
      '22:cat',
      '23:cat',
      '24:sub',
      '25:rest',
      '27:ctl',
    ]);
    expect(layout.categoriesEnd).toBe(25);
    expect(layout.control).toBe(27);
    expect(layout.lastRow).toBe(27);
  });

  it('labels categories in Russian, subcategories as in «Categories», indented', () => {
    const labels = Object.fromEntries(layout.rows.map((r) => [r.row, r.label]));
    expect(labels[13]).toBe('Жильё');
    expect(labels[14]).toBe('    Rent');
    expect(labels[16]).toBe('    без подкатегории / прочее');
    expect(labels[22]).toBe('Лиза');
    expect(labels[23]).toBe('Прочее');
    expect(labels[27]).toBe('Контроль: вне категорий');
  });

  it('groups the children of each category that has subcategories', () => {
    expect(layout.groups).toEqual([
      { category: 'Housing', header: 13, first: 14, last: 16 },
      { category: 'Food', header: 17, first: 18, last: 21 },
      { category: 'Other', header: 23, first: 24, last: 25 },
    ]);
  });

  it('refuses a sheet without expense categories', () => {
    expect(() => layoutOf([{ name: 'Income', subcategories: [] }])).toThrow(/категорий расходов/);
  });

  it('shows all fourteen live categories', () => {
    const live = [
      'Income',
      'Housing',
      'Food',
      'Transport',
      'Health',
      'Personal',
      'Subscriptions',
      'Entertainment',
      'Travel',
      'Education',
      'Family',
      'Liza',
      'Finance',
      'Investments',
      'Transfer',
      'Other',
    ].map((name) => ({ name, subcategories: ['A', 'B'] }));
    expect(layoutOf(live).rows.filter((r) => r.kind === 'cat')).toHaveLength(14);
  });
});

describe('«Недели» values', () => {
  const layout = layoutOf();

  it('spans A1:AJ<last row> and starts with the defaults of the controls', () => {
    expect(layout.weeks.range).toBe("'Недели'!A1:AJ27");
    expect(layout.weeks.values).toHaveLength(27);
    expect(layout.weeks.values.every((line) => line.length === 36)).toBe(true);
    expect(cell(layout, 'B2')).toBe('USD');
    expect(cell(layout, 'B3')).toBe(false);
    expect(cell(layout, 'B4')).toBe('');
  });

  it('starts the window at B4 or six months back, and each bucket on its day', () => {
    expect(cell(layout, 'B5')).toBe(
      '=IF(ISNUMBER($B$4),DATE(YEAR($B$4),MONTH($B$4),1),EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-5))',
    );
    expect(cell(layout, 'D5')).toBe('=DATE(YEAR($B$5),MONTH($B$5)+0,1)');
    expect(cell(layout, 'G5')).toBe('=DATE(YEAR($B$5),MONTH($B$5)+0,25)');
    expect(cell(layout, 'H5')).toBe('=DATE(YEAR($B$5),MONTH($B$5)+0,1)');
    expect(cell(layout, 'AC5')).toBe('=DATE(YEAR($B$5),MONTH($B$5)+5,1)');
    expect(cell(layout, 'AF5')).toBe('=DATE(YEAR($B$5),MONTH($B$5)+5,25)');
  });

  it('marks weeks with w and month totals with m', () => {
    const markers = layout.weeks.values[5]?.slice(3, 33);
    expect(markers).toHaveLength(30);
    expect(markers?.slice(0, 10)).toEqual(['w', 'w', 'w', 'w', 'm', 'w', 'w', 'w', 'w', 'm']);
    expect(markers?.filter((m) => m === 'm')).toHaveLength(6);
  });

  it('names the months in Russian once per month, over the first of its five columns', () => {
    const title = String(cell(layout, 'D7'));
    expect(title).toContain('CHOOSE(MONTH(D$5),"Январь"');
    expect(title).toContain('"Декабрь")&" "&YEAR(D$5)');
    expect(cell(layout, 'E7')).toBe('');
    expect(String(cell(layout, 'I7'))).toContain('CHOOSE(MONTH(I$5)');
  });

  it('labels the buckets, the last one up to the end of its month', () => {
    expect(cell(layout, 'A8')).toBe('="Категория, "&$B$2');
    expect([cell(layout, 'D8'), cell(layout, 'E8'), cell(layout, 'F8')]).toEqual([
      '1–8',
      '9–16',
      '17–24',
    ]);
    expect(cell(layout, 'G8')).toBe('="25–"&DAY(EOMONTH(G$5,0))');
    expect(cell(layout, 'H8')).toBe('Σ');
  });

  it('sums income and expenses by the bucket of the column, savings as their difference', () => {
    expect(cell(layout, 'D9')).toBe(
      `=SUMIFS('_Недели'!$H:$H,'_Недели'!$I:$I,D$5,'_Недели'!$B:$B,"Доход")`,
    );
    expect(cell(layout, 'D10')).toBe(
      `=SUMIFS('_Недели'!$H:$H,'_Недели'!$I:$I,D$5,'_Недели'!$B:$B,"Расход")`,
    );
    expect(cell(layout, 'E11')).toBe('=E9-E10');
    expect(cell(layout, 'H10')).toBe('=SUM(D10:G10)');
  });

  it('sums a category by its key and a subcategory by both keys', () => {
    expect(cell(layout, 'E13')).toBe(
      `=SUMIFS('_Недели'!$H:$H,'_Недели'!$I:$I,E$5,'_Недели'!$B:$B,"Расход",'_Недели'!$C:$C,$AH13)`,
    );
    expect(cell(layout, 'E14')).toBe(
      `=SUMIFS('_Недели'!$H:$H,'_Недели'!$I:$I,E$5,'_Недели'!$B:$B,"Расход",'_Недели'!$C:$C,$AH14,'_Недели'!$D:$D,$AI14)`,
    );
    expect(cell(layout, 'AG14')).toBe('=SUM(AC14:AF14)');
  });

  it('computes the remainder as the category less its subcategories, so nothing is lost', () => {
    expect(cell(layout, 'D16')).toBe('=ROUND(D13-SUM(D14:D15),2)');
    expect(cell(layout, 'J21')).toBe('=ROUND(J17-SUM(J18:J20),2)');
    expect(cell(layout, 'H16')).toBe('=SUM(D16:G16)');
    // A category without subcategories has no remainder to compute
    expect(cell(layout, 'D22')).toContain('$AH22)');
  });

  it('draws the trend over the weekly cells only, savings without a zero floor', () => {
    expect(cell(layout, 'B13')).toBe(
      '=SPARKLINE(FILTER($D13:$AG13,$D$6:$AG$6="w"),{"charttype","column";"ymin",0;"color","#e8590c"})',
    );
    expect(String(cell(layout, 'B11'))).not.toContain('ymin');
    expect(cell(layout, 'B27')).toBe('');
  });

  it('takes the norm from the median of the last six full months', () => {
    const category = String(cell(layout, 'C13'));
    expect(category).toBe(
      '=LET(monthStart,DATE(YEAR(TODAY()),MONTH(TODAY()),1),MEDIAN(MAP(SEQUENCE(6),LAMBDA(back,' +
        `SUMIFS('_Недели'!$H:$H,'_Недели'!$J:$J,EDATE(monthStart,-back),'_Недели'!$B:$B,"Расход",'_Недели'!$C:$C,$AH13)))))`,
    );
    expect(String(cell(layout, 'C14'))).toContain(`'_Недели'!$C:$C,$AH14,'_Недели'!$D:$D,$AI14)`);
    expect(String(cell(layout, 'C10'))).toContain(`"Расход")))))`);
    expect(cell(layout, 'C9')).toBe('');
    expect(cell(layout, 'C11')).toBe('');
  });

  it('takes the norm of the remainder as the category less each subcategory', () => {
    const rest = String(cell(layout, 'C16'));
    expect(rest).toContain('LAMBDA(back,ROUND(SUMIFS(');
    expect(rest).toContain(`$AH16)-SUMIFS(`);
    expect(rest).toContain(`$AH14,'_Недели'!$D:$D,$AI14)`);
    expect(rest).toContain(`$AH15,'_Недели'!$D:$D,$AI15)`);
    expect(rest).toContain(`$AI15),2)))))`);
    expect(rest).not.toContain('$AI16');
  });

  it('controls the sum of the categories against the total, in every column', () => {
    expect(cell(layout, 'D27')).toBe('=ROUND(D10-SUMIF($AJ$13:$AJ$25,"cat",D$13:D$25),2)');
    expect(cell(layout, 'H27')).toBe('=ROUND(H10-SUMIF($AJ$13:$AJ$25,"cat",H$13:H$25),2)');
    expect(String(cell(layout, 'C1'))).toContain('SUMPRODUCT(ABS($D$27:$AG$27))=0');
    expect(String(cell(layout, 'C1'))).toContain('"✓ сходится"');
  });

  it('keeps the keys in AH:AJ', () => {
    expect([cell(layout, 'AH13'), cell(layout, 'AI13'), cell(layout, 'AJ13')]).toEqual([
      'Housing',
      '',
      'cat',
    ]);
    expect([cell(layout, 'AH19'), cell(layout, 'AI19'), cell(layout, 'AJ19')]).toEqual([
      'Food',
      'Cafes & coffee',
      'sub',
    ]);
    expect([cell(layout, 'AH21'), cell(layout, 'AI21'), cell(layout, 'AJ21')]).toEqual([
      'Food',
      '',
      'rest',
    ]);
    expect(layout.weeks.values.map((line) => line[35]).filter(Boolean)).toHaveLength(17);
  });

  it('keeps names that look like numbers or formulas as text', () => {
    const odd = layoutOf([{ name: 'Food', subcategories: ['=SUM', '5 stars'] }]);
    expect(cell(odd, 'AI14')).toBe("'=SUM");
    expect(cell(odd, 'AI15')).toBe("'5 stars");
  });

  it('has the same layout after the migration, only the helper reads other columns', () => {
    const after = layoutOf(CATEGORIES, AFTER_MIGRATION);
    expect(after.weeks.values).toEqual(layout.weeks.values);
    expect(after.helper.values).not.toEqual(layout.helper.values);
  });

  it('shows one sample of each kind of formula for a dry run', () => {
    const samples = sampleFormulas(layout);
    expect(samples.map(([what]) => what)).toEqual([
      'помощник',
      'статус',
      'первый месяц',
      'начало недели',
      'название месяца',
      'доходы',
      'расходы',
      'сбережения',
      'категория',
      'подкатегория',
      'остаток',
      'Σ месяца',
      'тренд',
      'норма категории',
      'норма подкатегории',
      'норма остатка',
      'контроль',
    ]);
    expect(samples.every(([, , formula]) => formula.startsWith('='))).toBe(true);
    expect(samples.find(([what]) => what === 'остаток')?.[1]).toBe('D16');
  });
});

describe('addSheetRequests', () => {
  const layout = layoutOf();

  it('adds the helper hidden and big enough, and «Недели» frozen with the toggles above groups', () => {
    const [helper, weeks] = addSheetRequests(layout, { helperRows: 6000, weeksIndex: 3 });
    expect(helper?.addSheet?.properties).toMatchObject({
      title: '_Недели',
      hidden: true,
      gridProperties: { rowCount: 6000, columnCount: 10 },
    });
    expect(weeks?.addSheet?.properties).toMatchObject({
      title: 'Недели',
      index: 3,
      gridProperties: {
        rowCount: 37,
        columnCount: 36,
        frozenRowCount: 8,
        frozenColumnCount: 3,
        rowGroupControlAfter: false,
      },
    });
  });
});

describe('weeksRequests', () => {
  const layout = layoutOf();
  const ids = { weeks: 11, helper: 12 };
  const requests = weeksRequests(layout, ids);

  it('has the expected number of requests of each kind', () => {
    const counts: Record<string, number> = {};
    for (const request of requests) {
      const key = Object.keys(request)[0] ?? '?';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      updateDimensionProperties: 12, // 4 widths + 6 totals + hidden columns and rows
      repeatCell: 22, // 18 fixed styles and the bold row of each of the 4 categories
      updateBorders: 6,
      mergeCells: 6,
      setDataValidation: 3,
      addConditionalFormatRule: 24, // 6 overspend + control + status + 16 rows
      addDimensionGroup: 3,
      updateDimensionGroup: 3,
      addProtectedRange: 1,
    });
  });

  it('formats only «Недели» apart from the protection of the helper', () => {
    const sheetIds = JSON.stringify(requests).match(/"sheetId":\d+/g) ?? [];
    expect(new Set(sheetIds)).toEqual(new Set(['"sheetId":11', '"sheetId":12']));
    expect(sheetIds.filter((id) => id === '"sheetId":12')).toHaveLength(1);
  });

  it('hides the date and marker rows and the key columns', () => {
    const [columns, rows] = ofType(requests, 'updateDimensionProperties').slice(-2);
    expect(columns?.range).toMatchObject({ dimension: 'COLUMNS', startIndex: 33, endIndex: 36 });
    expect(columns?.properties).toEqual({ hiddenByUser: true });
    expect(rows?.range).toMatchObject({ dimension: 'ROWS', startIndex: 4, endIndex: 6 });
    expect(rows?.properties).toEqual({ hiddenByUser: true });
  });

  it('merges each month title over its five columns', () => {
    const merges = ofType(requests, 'mergeCells');
    expect(merges.map((m) => [m.range?.startColumnIndex, m.range?.endColumnIndex])).toEqual([
      [3, 8],
      [8, 13],
      [13, 18],
      [18, 23],
      [23, 28],
      [28, 33],
    ]);
    expect(merges[0]?.range).toMatchObject({ startRowIndex: 6, endRowIndex: 7 });
    expect(merges.every((m) => m.mergeType === 'MERGE_ALL')).toBe(true);
  });

  it('formats numbers with blank zeros', () => {
    const format = ofType(requests, 'repeatCell').find(
      (r) => r.cell?.userEnteredFormat?.numberFormat,
    );
    expect(format?.cell?.userEnteredFormat?.numberFormat).toEqual({
      type: 'NUMBER',
      pattern: '#,##0;-#,##0;;@',
    });
    expect(format?.range).toMatchObject({
      startRowIndex: 8,
      endRowIndex: 27,
      startColumnIndex: 2,
      endColumnIndex: 33,
    });
  });

  it('validates the controls', () => {
    const [currency, oneOff, firstMonth] = ofType(requests, 'setDataValidation');
    expect(currency?.range).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 1,
    });
    expect(currency?.rule?.condition).toEqual({
      type: 'ONE_OF_LIST',
      values: [{ userEnteredValue: 'USD' }, { userEnteredValue: 'RUB' }],
    });
    expect(currency?.rule?.strict).toBe(true);
    expect(oneOff?.range).toMatchObject({ startRowIndex: 2, endRowIndex: 3 });
    expect(oneOff?.rule?.condition?.type).toBe('BOOLEAN');
    expect(firstMonth?.range).toMatchObject({ startRowIndex: 3, endRowIndex: 4 });
    expect(firstMonth?.rule?.condition?.type).toBe('DATE_IS_VALID');
    expect(firstMonth?.rule?.inputMessage).toBe('Пусто — последние 6 месяцев');
  });

  it('collapses one group per category with subcategories, one level deep', () => {
    const added = ofType(requests, 'addDimensionGroup');
    expect(added.map((g) => [g.range?.startIndex, g.range?.endIndex])).toEqual([
      [13, 16],
      [17, 21],
      [23, 25],
    ]);
    expect(added.every((g) => g.range?.dimension === 'ROWS' && g.range.sheetId === 11)).toBe(true);

    const collapsed = ofType(requests, 'updateDimensionGroup');
    expect(collapsed.map((g) => g.dimensionGroup?.range)).toEqual(added.map((g) => g.range));
    expect(
      collapsed.every((g) => g.dimensionGroup?.collapsed && g.dimensionGroup.depth === 1),
    ).toBe(true);
    expect(collapsed.every((g) => g.fields === 'collapsed')).toBe(true);
    // Groups are added before they are collapsed
    const kinds = requests.map((r) => Object.keys(r)[0]);
    expect(kinds.lastIndexOf('addDimensionGroup')).toBeLessThan(
      kinds.indexOf('updateDimensionGroup'),
    );
  });

  it('protects only the helper, with a warning: a protected grid prompts on every group toggle', () => {
    const protections = ofType(requests, 'addProtectedRange');
    expect(protections).toHaveLength(1);
    expect(protections[0]?.protectedRange).toMatchObject({
      range: { sheetId: 12 },
      warningOnly: true,
    });
  });

  describe('conditional formats', () => {
    const rules = ofType(requests, 'addConditionalFormatRule');
    const gradients = rules.filter((r) => r.rule?.gradientRule);
    const booleans = rules.filter((r) => r.rule?.booleanRule);

    it('keeps the priority order explicit', () => {
      expect(rules.map((r) => r.index)).toEqual(rules.map((_, i) => i));
    });

    it('marks a month total over 1.3 × the norm, one rule per total column', () => {
      const overspend = booleans.slice(0, 6);
      expect(overspend.map((r) => r.rule?.ranges?.[0]?.startColumnIndex)).toEqual([
        7, 12, 17, 22, 27, 32,
      ]);
      expect(overspend[0]?.rule?.ranges?.[0]).toMatchObject({ startRowIndex: 9, endRowIndex: 25 });
      expect(overspend[0]?.rule?.booleanRule?.condition).toEqual({
        type: 'CUSTOM_FORMULA',
        values: [{ userEnteredValue: '=AND(ISNUMBER($C10),$C10>0,H10>1.3*$C10)' }],
      });
      expect(overspend[5]?.rule?.booleanRule?.condition?.values?.[0]?.userEnteredValue).toBe(
        '=AND(ISNUMBER($C10),$C10>0,AG10>1.3*$C10)',
      );
    });

    it('turns the control row and the status red when something is off', () => {
      const control = booleans[6]?.rule;
      expect(control?.ranges?.[0]).toMatchObject({ startRowIndex: 26, endRowIndex: 27 });
      expect(control?.booleanRule?.condition?.values?.[0]?.userEnteredValue).toBe(
        '=AND(ISNUMBER(D27),D27<>0)',
      );
      const status = booleans[7]?.rule;
      expect(status?.ranges?.[0]).toMatchObject({ startRowIndex: 0, startColumnIndex: 2 });
      expect(status?.booleanRule?.condition?.values?.[0]?.userEnteredValue).toBe(
        '=LEFT($C$1,1)<>"✓"',
      );
    });

    it('colors every row but the control one against its own maximum, over the weekly cells', () => {
      expect(gradients).toHaveLength(layout.rows.length - 1);
      const rent = gradients.find((r) => r.rule?.ranges?.[0]?.startRowIndex === 13)?.rule;
      expect(rent?.ranges).toHaveLength(6);
      expect(rent?.ranges?.map((r) => [r.startColumnIndex, r.endColumnIndex])).toEqual([
        [3, 7],
        [8, 12],
        [13, 17],
        [18, 22],
        [23, 27],
        [28, 32],
      ]);
      expect(rent?.ranges?.every((r) => r.endRowIndex === 14)).toBe(true);
      expect(rent?.gradientRule?.minpoint).toMatchObject({ type: 'NUMBER', value: '0' });
      // A row of zeros must stay white, so the top is never below 1
      expect(rent?.gradientRule?.maxpoint).toMatchObject({
        type: 'NUMBER',
        value: '=MAX(1,MAXIFS($D$14:$AG$14,$D$6:$AG$6,"w"))',
      });
    });

    it('colors categories stronger than their subcategories', () => {
      const maxColor = (startRowIndex: number) =>
        gradients.find((r) => r.rule?.ranges?.[0]?.startRowIndex === startRowIndex)?.rule
          ?.gradientRule?.maxpoint?.color;
      const category = maxColor(12); // Жильё
      const subcategory = maxColor(13); // Rent
      const rest = maxColor(15);
      expect(subcategory).toEqual(rest);
      expect(category).not.toEqual(subcategory);
      // lighter = closer to white in every channel
      expect(subcategory?.green).toBeGreaterThan(category?.green ?? 1);
    });

    it('runs savings from red through white at zero to green', () => {
      const savings = gradients.find((r) => r.rule?.ranges?.[0]?.startRowIndex === 10)?.rule
        ?.gradientRule;
      expect(savings?.minpoint?.type).toBe('MIN');
      expect(savings?.midpoint).toMatchObject({ type: 'NUMBER', value: '0' });
      expect(savings?.maxpoint?.type).toBe('MAX');
      expect(savings?.minpoint?.color?.red).toBe(1);
      expect(savings?.maxpoint?.color?.green).toBeGreaterThan(savings?.maxpoint?.color?.red ?? 1);
    });
  });
});

describe('checkWeeks', () => {
  const layout = layoutOf();
  const MONTH_STARTS = [46143, 46174, 46204, 46235, 46266, 46296]; // first days, increasing

  /** «Недели»!A1:AJ with the values the sheet would return once everything is calculated. */
  function weeksGrid(totals: number[] = [100, 200, 300, 400, 500, 600]): unknown[][] {
    const grid = layout.weeks.values.map(() => Array<unknown>(36).fill(''));
    const set = (row: number, col: number, value: unknown) => {
      const line = grid[row - 1];
      if (line) line[col] = value;
    };
    layout.weeks.values.forEach((line, r) =>
      line.slice(33).forEach((key, i) => set(r + 1, 33 + i, key)),
    );
    set(1, 2, '✓ сходится');
    set(2, 1, 'USD');
    set(3, 1, false);
    MONTH_STARTS.forEach((start, month) => {
      const sigma = 3 + month * 5 + 4;
      set(5, sigma, start);
      set(6, sigma, 'm');
      set(10, sigma, totals[month]);
    });
    for (let col = 3; col <= 32; col++) set(27, col, 0);
    return grid;
  }

  const helper: unknown[][] = [['Дата'], [46150, 'Расход']];
  const monthly: unknown[][] = [
    ['Категории по месяцам, USD'],
    [],
    ['Категория', 'Среднее', 'Медиана', 'P25', 'P75', 46143, 46174, 46204],
    ['Регулярные расходы, итого', 1, 1, 1, 1, 100, 200, 300],
    ['Housing', 1, 1, 1, 1, 1, 1, 1],
  ];

  it('passes when nothing is off and the totals match the other report', () => {
    const result = checkWeeks({ weeks: weeksGrid(), helper, monthly, categories: CATEGORIES });
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([expect.stringContaining('за 3 из 3 мес.')]);
  });

  it('reports a month whose total differs', () => {
    const result = checkWeeks({
      weeks: weeksGrid([100, 250, 300, 0, 0, 0]),
      helper,
      monthly,
      categories: CATEGORIES,
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('46174: 250 ≠ 200');
  });

  it('only compares in USD without one-offs', () => {
    const weeks = weeksGrid([1, 2, 3, 4, 5, 6]);
    if (weeks[1]) weeks[1][1] = 'RUB';
    const result = checkWeeks({ weeks, helper, monthly, categories: CATEGORIES });
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toContain('только в USD без разовых');
  });

  it('reports error values on either sheet', () => {
    const weeks = weeksGrid();
    if (weeks[12]) weeks[12][4] = '#REF!';
    const result = checkWeeks({
      weeks,
      helper: [['Дата'], [46150], ['#N/A']],
      monthly,
      categories: CATEGORIES,
    });
    expect(result.problems[0]).toContain('«Недели»!E13: #REF!');
    expect(result.problems[0]).toContain('«_Недели»!A3: #N/A');
  });

  it('reports a recalculation that is not finished', () => {
    const weeks = weeksGrid();
    if (weeks[12]) weeks[12][4] = 'Loading...';
    expect(
      checkWeeks({ weeks, helper: [['Дата']], monthly, categories: CATEGORIES }).problems,
    ).toEqual([
      expect.stringContaining('Loading...'),
      expect.stringContaining('A2 не вернула строк'),
    ]);
  });

  it('reports a control row that is not zero', () => {
    const weeks = weeksGrid();
    if (weeks[26]) weeks[26][7] = 12.5;
    if (weeks[0]) weeks[0][2] = '⚠ есть траты вне категорий';
    const result = checkWeeks({ weeks, helper, monthly, categories: CATEGORIES });
    expect(result.problems).toEqual([
      'Контроль не нулевой: H=12.5',
      'Статус «⚠ есть траты вне категорий»',
    ]);
  });

  it('works without the other report', () => {
    const result = checkWeeks({
      weeks: weeksGrid(),
      helper,
      monthly: null,
      categories: CATEGORIES,
    });
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toContain('Нет листа');
  });

  it('warns about categories that arrived after the sheet was made', () => {
    const grown: Category[] = [
      { name: 'Housing', subcategories: ['Rent', 'Utilities', 'Repairs'] },
      { name: 'Pets', subcategories: ['Food'] },
      { name: 'Food', subcategories: ['Groceries'] },
    ];
    const result = checkWeeks({ weeks: weeksGrid(), helper, monthly, categories: grown });
    expect(result.problems).toEqual([]);
    expect(result.notes.at(-1)).toContain('Housing / Repairs');
    expect(result.notes.at(-1)).toContain('Pets (вся категория)');
    expect(uncoveredSubcategories(CATEGORIES, layout.weeks.values)).toEqual([]);
    expect(uncoveredSubcategories(grown, layout.weeks.values)).toEqual([
      'Housing / Repairs',
      'Pets (вся категория)',
    ]);
  });
});

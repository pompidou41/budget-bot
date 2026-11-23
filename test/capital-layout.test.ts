import { describe, expect, it } from 'vitest';
import { isoToSerial } from '../src/domain/dates.js';
import {
  balanceAt,
  capitalAccounts,
  checkCapital,
  cutoffPoints,
  monthAgoPoint,
  movements,
  pointAt,
} from '../src/sheets/capital-check.js';
import {
  accountIndexes,
  COL,
  cutoffsFormula,
  HELPER_ROWS,
  matrixFormula,
  metaFormulas,
  NOW_CUTOFF,
  operationIndexes,
  ROWS,
  type CapitalInput,
} from '../src/sheets/capital-layout.js';
import { capitalValues } from '../src/sheets/capital-values.js';

const OPS_HEADER = [
  'Дата', 'Тип', 'Счёт', 'Сумма', 'Счёт куда', 'Получено', 'Категория', 'Подкатегория',
  'Комментарий', 'Разовая', 'Курс (ручной)', 'Добавлено', 'Валюта', 'Курс', 'Сумма USD',
  'Валюта получ.', 'Курс получ.', 'Получено USD', 'Потеря на обмене USD', 'Получено (расч.)', 'Месяц',
]; // prettier-ignore
const ACCOUNTS_HEADER = [
  'ID', 'Название', 'Банк / место', 'Тип', 'Валюта', 'Группа', 'В капитале',
  'Начальный остаток', 'Дата начала', 'Остаток', 'Остаток USD',
]; // prettier-ignore

const START = isoToSerial('2026-09-11');
const day = (iso: string) => isoToSerial(iso);

// RUB 100 per USD; T_SAVE holds savings, OLD is a closed card, LOAN_X is out of capital
const RATES = [[], [], [], ['USD', 'USD за 1', 1, '', 1], ['RUB', 'за 1 USD', 100, '', 100]];
const ACCOUNTS = [
  ACCOUNTS_HEADER,
  ['T_MAIN', '', '', 'Карта', 'RUB', 'Текущие', true, 10000, START, 0, 120],
  ['T_SAVE', '', '', 'Накопительный', 'RUB', 'Подушка', true, 50000, START, 0, 500],
  ['OLD', '', '', 'Карта', 'USD', 'Архив', false, 20, START, 0, 0],
  ['LOAN_X', '', '', 'Кредит', 'RUB', 'Кредиты', false, -9999, START, 0, -99.99],
  ['ARCHIVE', '', '', 'Архив', 'RUB', 'Архив', false, 0, '', 0, 777],
];
function op(date: string, type: string, account: string, amount: number, to = '', received = 0) {
  const row: unknown[] = Array(OPS_HEADER.length).fill('');
  Object.assign(row, { 0: day(date), 1: type, 2: account, 3: amount, 4: to, 19: received });
  return row;
}
const OPERATIONS = [
  OPS_HEADER,
  op('2026-09-01', 'Расход', 'T_MAIN', 999), // before «Дата начала»: not counted
  op('2026-09-12', 'Доход', 'T_MAIN', 6000),
  op('2026-09-20', 'Перевод', 'T_MAIN', 4000, 'T_SAVE', 4000),
  op('2026-09-21', 'Перевод', 'OLD', 20, 'T_MAIN', 2000),
  op('2026-10-02', 'Расход', 'T_MAIN', 12000),
  op('2026-10-03', 'Доход', 'ARCHIVE', 777),
];

const input: CapitalInput = (() => {
  const ops = operationIndexes(OPS_HEADER);
  const accounts = accountIndexes(ACCOUNTS_HEADER);
  if (!ops.ok || !accounts.ok) throw new Error('headers');
  return { ops: ops.indexes, accounts: accounts.indexes, rubRow: 5 };
})();

describe('capital layout formulas', () => {
  it('finds the columns by header and reports the missing ones', () => {
    expect(input.ops).toMatchObject({ date: 0, account: 2, toAccount: 4, received: 19 });
    expect(accountIndexes(['ID', 'Тип'])).toEqual({
      ok: false,
      missing: [
        'Валюта',
        'Группа',
        'В капитале',
        'Начальный остаток',
        'Дата начала',
        'Остаток USD',
      ],
    });
  });

  it('keeps accounts in capital and closed ones, never the history account', () => {
    const { id, group } = metaFormulas(input);
    expect(id).toContain(`'Счета'!$A$2:$A<>"ARCHIVE"`);
    expect(id).toContain(`('Счета'!$G$2:$G=TRUE)`);
    expect(group).toContain(`IF((('Счета'!$F$2:$F="Архив")+('Счета'!$D$2:$D="Архив")>0)`);
    expect(group).toContain('"Закрытые"');
  });

  it('mirrors «Счета»!J: incoming transfers by «Получено (расч.)», dates from «Дата начала»', () => {
    const matrix = matrixFormula(input);
    expect(matrix).toContain(`SUMIFS('Операции'!$T$2:$T,'Операции'!$E$2:$E,accId`);
    expect(matrix).toContain(`'Операции'!$A$2:$A,">="&fromDay,'Операции'!$A$2:$A,"<"&toDay`);
    expect(cutoffsFormula()).toContain(
      `(1-($B$3="Месяцы"))*((dom=9)+(dom=17)+(dom=25))),${NOW_CUTOFF}`,
    );
  });

  it('puts the spilling formulas where the layout expects them', () => {
    const ranges = capitalValues(input).map((v) => v.range);
    expect(ranges).toEqual(
      expect.arrayContaining([
        `'Капитал'!A${ROWS.first}`,
        `'Капитал'!B${ROWS.first}`,
        `'Капитал'!C${ROWS.first + 1}`,
        `'Капитал'!O${ROWS.first}`,
        `'Капитал'!Q${ROWS.first}`,
        `'Капитал'!A${ROWS.currency}:B${ROWS.step}`,
        `'Капитал'!Q7`,
      ]),
    );
  });
});

describe('capital recomputation', () => {
  const accounts = capitalAccounts(ACCOUNTS, RATES);
  const ops = movements(OPERATIONS);

  it('includes closed accounts as «Закрытые» and skips ARCHIVE and out-of-capital ones', () => {
    expect(accounts.map((a) => `${a.id}:${a.group}`)).toEqual([
      'T_MAIN:Текущие',
      'T_SAVE:Подушка',
      'OLD:Закрытые',
    ]);
  });

  it('counts movements from «Дата начала» up to the morning of the cutoff', () => {
    const main = accounts[0]!;
    expect(balanceAt(main, ops, day('2026-09-12'))).toBe(10000);
    expect(balanceAt(main, ops, day('2026-09-25'))).toBe(10000 + 6000 - 4000 + 2000);
    expect(balanceAt(main, ops, NOW_CUTOFF)).toBe(2000);
  });

  it('sums capital and savings in USD', () => {
    const point = pointAt(accounts, ops, day('2026-09-25'));
    expect(point.capital).toBeCloseTo(140 + 540 + 0);
    expect(point.savings).toBeCloseTo(540);
    expect(point.groups['Закрытые']).toBe(0);
    expect(pointAt(accounts, ops, START).groups['Закрытые']).toBe(20);
  });

  it('places points on the start, every 1/9/17/25 and «сейчас»', () => {
    const points = cutoffPoints(accounts, day('2026-10-10'));
    expect(points).toEqual([
      START,
      day('2026-09-17'),
      day('2026-09-25'),
      day('2026-10-01'),
      day('2026-10-09'),
      NOW_CUTOFF,
    ]);
    expect(cutoffPoints(accounts, day('2026-11-15'), 'Месяцы')).toEqual([
      START,
      day('2026-10-01'),
      day('2026-11-01'),
      NOW_CUTOFF,
    ]);
  });

  it('compares «за месяц» with the first weekly point not older than a month', () => {
    expect(monthAgoPoint(accounts, day('2026-11-15'))).toBe(day('2026-10-17'));
    expect(monthAgoPoint(accounts, day('2026-09-20'))).toBe(START);
  });
});

function sheetFor(cutoffs: number[], tweak = 0): unknown[][] {
  const accounts = capitalAccounts(ACCOUNTS, RATES);
  const ops = movements(OPERATIONS);
  const sheet: unknown[][] = Array.from({ length: ROWS.first - 1 }, () => []);
  sheet[HELPER_ROWS.rate - 1]![COL.helper] = 1;
  // «За месяц» against the first point: Δ = now − start
  sheet[HELPER_ROWS.monthAgo - 1]![COL.helper] = cutoffs[0];
  const [first, now] = [cutoffs[0]!, cutoffs.at(-1)!].map((c) => pointAt(accounts, ops, c));
  sheet[ROWS.capital - 1]![COL.capitalDelta] = now!.capital - first!.capital;
  sheet[ROWS.savings - 1]![COL.capitalDelta] = now!.savings - first!.savings + tweak;
  for (const cutoff of cutoffs) {
    const point = pointAt(accounts, ops, cutoff);
    const line: unknown[] = [];
    line[COL.capital] = point.capital + tweak;
    line[COL.savings] = point.savings;
    Object.values(point.groups).forEach((v, i) => (line[COL.firstGroup + i] = v));
    line[COL.helper] = cutoff;
    sheet.push(line);
  }
  return sheet;
}

describe('checkCapital', () => {
  const base = { operations: OPERATIONS, accounts: ACCOUNTS, rates: RATES };
  const cutoffs = [START, day('2026-10-01'), NOW_CUTOFF];
  const sheetK = ACCOUNTS.map((row) => [...row]);
  // «Остаток USD» consistent with the operations: 20 + 50 + 0 USD now
  sheetK[1]![10] = 20;
  sheetK[2]![10] = 540;
  sheetK[3]![10] = 0;

  it('passes when every point matches and «сейчас» equals «Счета»', () => {
    const result = checkCapital({ ...base, accounts: sheetK, sheet: sheetFor(cutoffs) });
    expect(result.problems).toEqual([]);
    expect(result.points.at(-1)?.capital).toBeCloseTo(560);
  });

  it('reports a point that drifted and cells with errors', () => {
    const sheet = sheetFor(cutoffs, 5);
    sheet[0] = ['Капитал и сбережения', '#REF!'];
    const { problems } = checkCapital({ ...base, accounts: sheetK, sheet });
    expect(problems[0]).toBe('B1: #REF!');
    expect(problems.some((p) => p.startsWith('сейчас: капитал 565.00 ≠ 560.00'))).toBe(true);
    expect(problems.some((p) => p.startsWith('Сводка «Сбережения» за месяц'))).toBe(true);
  });
});

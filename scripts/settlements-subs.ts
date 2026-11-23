/** Step A5 of setup-settlements: hidden «_Подкатегории» and the dependent dropdown in «Операции»!H. */
import { subsRequests } from '../src/sheets/settlements-requests.js';
import {
  ruleProblems,
  SUBS_FORMULA,
  SUBS_SHEET,
  subsColumns,
  subsRows,
} from '../src/sheets/subcategories-plan.js';
import { columnLetter } from '../src/sheets/weeks-layout.js';
import type { Ctx, SheetInfo, Step } from './setup-settlements.js';

const H = 7;
const SPOTS = [0, 98];

export async function buildSubsStep(
  all: Map<string, SheetInfo>,
  ops: SheetInfo,
  longest: number,
  ctx: Ctx,
): Promise<Step> {
  const existing = all.get(SUBS_SHEET);
  const columns = subsColumns(longest);
  const rows = subsRows(ops.rows, existing?.rows);
  const sheetId = existing?.sheetId ?? Math.max(...[...all.values()].map((s) => s.sheetId)) + 1;

  let fillFormulas = existing === undefined || existing.rows < rows;
  if (existing && !fillFormulas) {
    const edges = await Promise.all(
      [2, existing.rows].map((r) => ctx.read(`'${SUBS_SHEET}'!A${r}`, 'FORMULA')),
    );
    fillFormulas = edges.some((e) => e[0]?.[0] !== SUBS_FORMULA);
  }
  const [rules = []] = await ctx.readRules(`'${ops.title}'!H2:H${ops.rows}`, 1);
  const setRule = rules.length < ops.rows - 1 || ruleProblems(rules, columns).length > 0;

  const lines: string[] = [];
  if (!existing) {
    lines.push(`создать скрытый лист «${SUBS_SHEET}»: ${rows} строк × ${columns} столбцов`);
  }
  if (fillFormulas) {
    lines.push(`формула подкатегорий в A2:A${rows} (строка N ↔ «Операции» строка N)`);
  }
  if (setRule) {
    const to = `$${columnLetter(columns - 1)}2`;
    lines.push(
      `«Операции»!H2:H${ops.rows}: список из '${SUBS_SHEET}'!$A2:${to} (строка относительная)`,
    );
  }

  const verify = () =>
    ctx.retry(async () => {
      const [after = []] = await ctx.readRules(`'${ops.title}'!H2:H${ops.rows}`, 1);
      // Spot checks (H2, H100, last row): each must point at its own line, not at row 2
      const probes = [...SPOTS, after.length - 1].filter((i) => i >= 0 && i < after.length);
      const problems = probes.flatMap((i) =>
        ruleProblems([after[i]], columns).map((p) => p.replace(/^H\d+/, `H${i + 2}`)),
      );
      if (problems.length > 0) {
        return ['правила H не относительные (если API хранит буквально — сообщить):', ...problems];
      }
      return lizaCheck(ops, columns, ctx);
    });

  return {
    name: 'A5 _Подкатегории + список в H',
    lines,
    requests: subsRequests({
      sheetId,
      create: existing === undefined,
      rows,
      longestList: longest,
      operationsSheetId: ops.sheetId,
      operationsRows: ops.rows,
      fillFormulas,
      addRows: existing ? Math.max(0, rows - existing.rows) : 0,
      setRule,
      operationsColumn: H,
    }),
    verify,
  };
}

/** A real «Операции» row with category Liza must list the Liza subcategories in its own line. */
async function lizaCheck(ops: SheetInfo, columns: number, ctx: Ctx): Promise<string[]> {
  const categories = await ctx.read(`'${ops.title}'!G2:G${ops.rows}`);
  const index = categories.findIndex((r) => String(r[0] ?? '').trim() === 'Liza');
  if (index === -1) return [];
  const row = index + 2;
  const line = await ctx.read(`'${SUBS_SHEET}'!A${row}:${columnLetter(columns - 1)}${row}`);
  return (line[0] ?? []).includes('Allowance')
    ? []
    : [`строка ${row} «${SUBS_SHEET}» без подкатегорий Liza`];
}

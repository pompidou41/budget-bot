import { formatDateRu } from '../domain/dates.js';
import { escapeHtml, formatAmount } from '../domain/format.js';
import { parseEntry } from '../domain/last.js';
import { findAccount, type Reference } from '../domain/reference.js';

/** Telegram caps a message at 4096 characters; stay well below and cut the list. */
const MAX_LINES = 25;
const MAX_CHARS = 3200;
const COMMENT_LIMIT = 40;

export interface PreviewRow {
  row: number;
  cells: unknown[];
}

interface Totals {
  spent: number;
  income: number;
  transfer: number;
}

function currencyTotals(rows: PreviewRow[], ref: Reference): string[] {
  const byCurrency = new Map<string, Totals>();
  for (const { row, cells } of rows) {
    const op = parseEntry(cells, row)?.op;
    if (!op || op.amount === null) continue;
    const currency = (op.account && findAccount(ref, op.account)?.currency) || '?';
    const totals = byCurrency.get(currency) ?? { spent: 0, income: 0, transfer: 0 };
    if (op.type === 'Расход') totals.spent += op.amount;
    else if (op.type === 'Доход') totals.income += op.amount;
    else totals.transfer += op.amount;
    byCurrency.set(currency, totals);
  }
  return [...byCurrency].map(([currency, t]) => {
    const parts = [
      t.spent > 0 ? `расходы ${formatAmount(t.spent)}` : '',
      t.income > 0 ? `доходы ${formatAmount(t.income)}` : '',
      t.transfer > 0 ? `переводы ${formatAmount(t.transfer)}` : '',
    ].filter(Boolean);
    return `${currency}: ${parts.join(', ')}`;
  });
}

function line({ row, cells }: PreviewRow, ref: Reference): string {
  const op = parseEntry(cells, row)?.op;
  if (!op) return `• строка ${row}`;
  const currency = (op.account && findAccount(ref, op.account)?.currency) || '';
  const amount = op.amount === null ? '?' : `${formatAmount(op.amount)} ${currency}`.trim();
  const comment =
    op.comment.length > COMMENT_LIMIT ? `${op.comment.slice(0, COMMENT_LIMIT)}…` : op.comment;
  return `• ${formatDateRu(op.date).slice(0, 5)} · ${escapeHtml(amount)} · ${escapeHtml(comment)}`;
}

/**
 * Confirmation text for «Отменить импорт»: built from the rows found in the sheet right now.
 * `written` is how many rows the import wrote; those not among `found` are left untouched.
 */
export function renderImportUndoPreview(
  found: PreviewRow[],
  written: number,
  ref: Reference,
): string {
  const sorted = [...found].sort((a, b) => a.row - b.row);
  const lines = [
    '↩️ <b>Отменить импорт?</b>',
    `Из таблицы будет удалено строк: <b>${found.length}</b> из ${written} записанных.`,
  ];
  if (found.length < written) {
    lines.push(
      `⚠️ Остальные ${written - found.length} не нашёл целыми (изменены или отсортированы) — их не трогаю.`,
    );
  }
  lines.push(...currencyTotals(sorted, ref), '');

  let size = lines.join('\n').length;
  let shown = 0;
  for (const row of sorted) {
    const text = line(row, ref);
    if (shown >= MAX_LINES || size + text.length > MAX_CHARS) break;
    lines.push(text);
    size += text.length + 1;
    shown++;
  }
  if (shown < sorted.length) lines.push(`…и ещё ${sorted.length - shown}`);
  lines.push('', 'Пока не нажмёшь «Да, удалить», ничего не удалится.');
  return lines.join('\n');
}

import { summarize } from '../domain/duplicates.js';
import { escapeHtml, formatAmount } from '../domain/format.js';
import { findAccount, type Reference } from '../domain/reference.js';
import type { ImportSession } from '../state/imports.js';
import { effectOn, type ImportItem, type ItemStatus } from './plan.js';
import { coveredDates } from './statement.js';

const MISSING_SHOWN = 5;
/** Telegram allows 4096 characters; leave room for HTML entities. */
const CHUNK_LIMIT = 3500;

function dayMonth(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

function signed(amount: number): string {
  return `${amount < 0 ? '−' : '+'}${formatAmount(Math.abs(amount))}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function count(items: ImportItem[], ...statuses: ItemStatus[]): number {
  return items.filter((item) => statuses.includes(item.status)).length;
}

function header(session: ImportSession): string[] {
  const { statement } = session;
  const dates = coveredDates(statement.rows);
  const out = statement.rows.filter((r) => r.direction === 'out').reduce((s, r) => s + r.amount, 0);
  const into = statement.rows.filter((r) => r.direction === 'in').reduce((s, r) => s + r.amount, 0);
  const where = session.account ? ` · ${escapeHtml(session.account)}` : '';
  return [
    `📄 <b>Выписка</b>${where} · ${dates ? `${dayMonth(dates.from)} – ${dayMonth(dates.to)}` : ''}`,
    `${statement.rows.length} операций: −${formatAmount(round2(out))} / +${formatAmount(round2(into))} ${escapeHtml(statement.currency)}`,
  ];
}

function counters(session: ImportSession): string[] {
  const { items } = session;
  const doubtful = count(items, 'doubtful', 'drafted');
  const similar = items.filter((i) => i.status !== 'recorded' && i.duplicate).length;
  const ready = items.filter((i) => i.status === 'ready');
  const net = ready.reduce((sum, item) => sum + effectOn(item.op, session.account ?? ''), 0);
  const written = session.written.length;
  const lines = [`⏭ ${count(items, 'recorded')} уже в таблице — пропускаю`];
  if (doubtful > 0) {
    lines.push(
      `⚠️ ${doubtful} на проверку${similar > 0 ? `, из них ${similar} похожи на записанные` : ''}`,
    );
  }
  if (ready.length > 0) {
    lines.push(
      `🆕 ${ready.length} готовы к записи: ${signed(round2(net))} ${escapeHtml(session.statement.currency)}`,
    );
  }
  if (written > 0) {
    const rows = session.written.map((w) => w.row);
    lines.push(`✅ Записано ${written} · строки ${Math.min(...rows)}–${Math.max(...rows)}`);
  }
  return lines;
}

function missing(session: ImportSession): string[] {
  if (session.missing.length === 0) return [];
  const shown = session.missing.slice(0, MISSING_SHOWN);
  const more = session.missing.length - shown.length;
  return [
    '',
    `📋 В таблице есть, в выписке нет — ${session.missing.length}:`,
    ...shown.map((line) => `• ${line}`),
    ...(more > 0 ? [`… и ещё ${more} в «📋 Список»`] : []),
  ];
}

function balance(session: ImportSession): string[] {
  const { statement, account, sheetBalance } = session;
  if (statement.closing === null || !account || sheetBalance === null) return [];
  // The balance was read before anything was written, so written rows count as well
  const counted = session.items.filter((i) => i.status === 'ready' || i.status === 'written');
  const pending = counted.filter((i) => i.status === 'ready');
  const after = round2(sheetBalance + counted.reduce((sum, i) => sum + effectOn(i.op, account), 0));
  const gap = round2(after - statement.closing);
  const currency = escapeHtml(statement.currency);
  const verdict =
    Math.abs(gap) < 0.01 ? '✅ сходится' : `расхождение ${formatAmount(Math.abs(gap))} ${currency}`;
  return [
    '',
    `🧮 Остаток по выписке ${formatAmount(statement.closing)} ${currency}, ` +
      `в таблице ${pending.length > 0 ? 'после записи ' : ''}${formatAmount(after)} — ${verdict}`,
  ];
}

/** The summary message of an import, in Telegram HTML. */
export function renderImportSummary(session: ImportSession): string {
  const lines = header(session);
  if (session.stage === 'account') {
    lines.push('', 'Не понял, чей это счёт. На какой счёт разнести?');
    return lines.join('\n');
  }
  if (session.stage === 'cancelled') return [...lines, '', '❌ Импорт отменён'].join('\n');
  if (session.stage === 'undone') {
    return [...lines, '', `↩️ Импорт отменён, строки убраны из таблицы`].join('\n');
  }
  lines.push('', ...counters(session), ...missing(session), ...balance(session));
  if (session.problems.length > 0) {
    lines.push('', '⚠️ Остатки в самой выписке не сходятся — проверь строки:');
    lines.push(...session.problems.slice(0, 3).map((p) => `• ${escapeHtml(p)}`));
  }
  return lines.join('\n');
}

const ICON: Record<ItemStatus, string> = {
  ready: '🆕',
  written: '✅',
  doubtful: '⚠️',
  drafted: '⚠️',
  recorded: '⏭',
};

function itemLine(item: ImportItem, ref: Reference): string {
  const category = item.op.category
    ? `${item.op.category}${item.op.subcategory ? ` › ${item.op.subcategory}` : ''}`
    : 'без категории';
  const line = `${ICON[item.status]} #${item.row} ${summarize(item.op, ref)} · ${escapeHtml(category)}`;
  return item.duplicate ? `${line}\n      ↳ ${item.duplicate}` : line;
}

/** Every row of the import grouped by what happens to it, split into Telegram-sized messages. */
export function renderImportList(session: ImportSession, ref: Reference): string[] {
  const order: ItemStatus[] = ['doubtful', 'drafted', 'ready', 'written', 'recorded'];
  const lines = order.flatMap((status) =>
    session.items.filter((i) => i.status === status).map((i) => itemLine(i, ref)),
  );
  if (session.missing.length > 0) {
    lines.push(
      '',
      '<b>В таблице есть, в выписке нет:</b>',
      ...session.missing.map((m) => `• ${m}`),
    );
  }
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > CHUNK_LIMIT) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function accountLabel(ref: Reference, id: string): string {
  const account = findAccount(ref, id);
  return account ? `${account.id} · ${account.name}` : id;
}

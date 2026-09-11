import { formatDateRu, weekday } from './dates.js';
import { escapeHtml, formatAmount } from './format.js';
import type { Operation, OpType } from './operation.js';
import { findAccount, type Reference } from './reference.js';

const TYPE_ICON: Record<OpType, string> = {
  Расход: '📉',
  Доход: '📈',
  Перевод: '🔁',
};

export interface CardExtras {
  problems?: string[];
  transcript?: string;
  note?: string;
  /** Trusted HTML appended at the bottom (status line). */
  footer?: string;
}

function accountLabel(ref: Reference, id: string | null): string {
  if (!id) return '❓';
  const account = findAccount(ref, id);
  return account
    ? `${escapeHtml(account.id)} <i>(${escapeHtml(account.name)})</i>`
    : escapeHtml(id);
}

function currencyOf(ref: Reference, id: string | null): string {
  return (id && findAccount(ref, id)?.currency) || '';
}

function amountLabel(amount: number | null, currency: string): string {
  if (amount === null) return '❓';
  return currency ? `${formatAmount(amount)} ${currency}` : formatAmount(amount);
}

/** HTML card of an operation, used for drafts, saved records and undo previews. */
export function renderCard(op: Operation, ref: Reference, extras: CardExtras = {}): string {
  const lines: string[] = [];

  if (extras.transcript) lines.push(`🎙 <i>${escapeHtml(extras.transcript)}</i>`, '');

  lines.push(
    `${TYPE_ICON[op.type]} <b>${op.type}</b> · ${formatDateRu(op.date)} (${weekday(op.date)})`,
  );

  const fromCurrency = currencyOf(ref, op.account);
  if (op.type === 'Перевод') {
    const toCurrency = currencyOf(ref, op.toAccount);
    const received =
      op.received ?? (op.amount !== null && fromCurrency === toCurrency ? op.amount : null);
    lines.push(`🏦 ${accountLabel(ref, op.account)} → ${accountLabel(ref, op.toAccount)}`);
    lines.push(
      `💰 ${amountLabel(op.amount, fromCurrency)}` +
        (op.toAccount ? ` → ${amountLabel(received, toCurrency)}` : ''),
    );
  } else {
    lines.push(`🏦 ${accountLabel(ref, op.account)}`);
    lines.push(`💰 ${amountLabel(op.amount, fromCurrency)}`);
  }

  const category = op.category
    ? escapeHtml(op.category) + (op.subcategory ? ` › ${escapeHtml(op.subcategory)}` : '')
    : '❓';
  lines.push(`📂 ${category}`);

  if (op.comment) lines.push(`💬 ${escapeHtml(op.comment)}`);
  if (op.oneOff) lines.push('⚡ Разовая');
  if (op.manualRate !== null) lines.push(`💱 Курс: ${formatAmount(op.manualRate)}`);

  if (extras.note) lines.push('', `ℹ️ ${escapeHtml(extras.note)}`);
  if (extras.problems?.length) {
    lines.push('', ...extras.problems.map((p) => `⚠️ ${escapeHtml(p)}`));
  }
  if (extras.footer) lines.push('', extras.footer);

  return lines.join('\n');
}

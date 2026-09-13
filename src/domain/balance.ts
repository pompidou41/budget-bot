import { escapeHtml, escapeRich, formatAmount, formatUsd } from './format.js';
import { activeAccounts, type Account, type Reference } from './reference.js';

function groupAccounts(ref: Reference): Map<string, Account[]> {
  const groups = new Map<string, Account[]>();
  for (const account of activeAccounts(ref)) {
    const list = groups.get(account.group) ?? [];
    list.push(account);
    groups.set(account.group, list);
  }
  return groups;
}

function nativeAmount(account: Account): string {
  if (account.balance === null) return '—';
  return `${formatAmount(Math.round(account.balance * 1e6) / 1e6)} ${account.currency}`;
}

/** Balances from «Счета» (J/K formulas) grouped by column F, plus capital in USD. */
export function renderBalance(ref: Reference): string {
  const groups = groupAccounts(ref);
  const lines = ['<b>Остатки по счетам</b>'];
  let capital = 0;

  for (const [group, accounts] of groups) {
    const groupUsd = accounts.reduce((sum, a) => sum + (a.balanceUsd ?? 0), 0);
    lines.push('', `<b>${escapeHtml(group || 'Без группы')}</b> · ≈ ${formatUsd(groupUsd)}`);

    for (const a of accounts) {
      const amount = nativeAmount(a);
      const usd =
        a.currency !== 'USD' && a.balanceUsd !== null ? ` (≈ ${formatUsd(a.balanceUsd)})` : '';
      lines.push(`• ${escapeHtml(a.name)} <code>${escapeHtml(a.id)}</code>: ${amount}${usd}`);
      if (a.inCapital) capital += a.balanceUsd ?? 0;
    }
  }

  lines.push('', `💼 <b>Капитал:</b> ≈ ${formatUsd(capital)}`);
  return lines.join('\n');
}

/** The same balances as a rich table: one row per account, grouped by a heading. */
export function renderBalanceRich(ref: Reference): string {
  const parts = ['<h3>💰 Остатки по счетам</h3>'];
  let capital = 0;

  for (const [group, accounts] of groupAccounts(ref)) {
    const groupUsd = accounts.reduce((sum, a) => sum + (a.balanceUsd ?? 0), 0);
    parts.push(
      `<h4>${escapeRich(group || 'Без группы')} · ≈ ${escapeRich(formatUsd(groupUsd))}</h4>`,
    );

    const rows = accounts.map((a) => {
      if (a.inCapital) capital += a.balanceUsd ?? 0;
      // The USD column stays empty for USD accounts rather than repeating the same figure
      const usd =
        a.currency !== 'USD' && a.balanceUsd !== null ? `≈ ${formatUsd(a.balanceUsd)}` : '';
      return [
        `<td align="left">${escapeRich(a.name)}</td>`,
        `<td align="right">${escapeRich(nativeAmount(a))}</td>`,
        `<td align="right">${escapeRich(usd)}</td>`,
      ].join('');
    });

    parts.push(`<table striped compact>${rows.map((r) => `<tr>${r}</tr>`).join('')}</table>`);
  }

  parts.push(`<p>💼 <b>Капитал:</b> ≈ ${escapeRich(formatUsd(capital))}</p>`);
  return parts.join('');
}

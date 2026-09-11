import { escapeHtml, formatAmount, formatUsd } from './format.js';
import { activeAccounts, type Account, type Reference } from './reference.js';

/** Balances from «Счета» (J/K formulas) grouped by column F, plus capital in USD. */
export function renderBalance(ref: Reference): string {
  const groups = new Map<string, Account[]>();
  for (const account of activeAccounts(ref)) {
    const list = groups.get(account.group) ?? [];
    list.push(account);
    groups.set(account.group, list);
  }

  const lines = ['<b>Остатки по счетам</b>'];
  let capital = 0;

  for (const [group, accounts] of groups) {
    const groupUsd = accounts.reduce((sum, a) => sum + (a.balanceUsd ?? 0), 0);
    lines.push('', `<b>${escapeHtml(group || 'Без группы')}</b> · ≈ ${formatUsd(groupUsd)}`);

    for (const a of accounts) {
      const amount =
        a.balance === null
          ? '—'
          : `${formatAmount(Math.round(a.balance * 1e6) / 1e6)} ${a.currency}`;
      const usd =
        a.currency !== 'USD' && a.balanceUsd !== null ? ` (≈ ${formatUsd(a.balanceUsd)})` : '';
      lines.push(`• ${escapeHtml(a.name)} <code>${escapeHtml(a.id)}</code>: ${amount}${usd}`);
      if (a.inCapital) capital += a.balanceUsd ?? 0;
    }
  }

  lines.push('', `💼 <b>Капитал:</b> ≈ ${formatUsd(capital)}`);
  return lines.join('\n');
}

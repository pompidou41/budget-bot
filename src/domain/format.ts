export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatAmount(amount: number): string {
  return amount.toLocaleString('ru-RU', { maximumFractionDigits: 8 });
}

export function formatUsd(amount: number): string {
  const rounded = Math.round(Math.abs(amount) * 100) / 100;
  return `${amount < 0 ? '−' : ''}$${formatAmount(rounded)}`;
}

/**
 * Parse a user-typed amount: "1500", "1 500,50", "1.5к", "2k", "3 тыс".
 * Returns null for anything that is not a positive number.
 */
export function parseAmount(input: string): number | null {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, '').replace(',', '.');
  const match = normalized.match(/^(\d+(?:\.\d+)?)(к|k|тыс\.?)?$/);
  if (!match) return null;

  const base = Number(match[1]);
  const amount = match[2] ? base * 1000 : base;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return Math.round(amount * 1e8) / 1e8;
}

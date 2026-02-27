import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type TransactionType,
} from '../../config/categories.js';
import type { Transaction } from '../../sheets/index.js';

interface ParsedMessage {
  transaction: Transaction;
  confidence: 'high' | 'low';
}

const allCategories = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];

function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function findCategory(input: string): { category: string; type: TransactionType } | null {
  const normalized = normalizeText(input);

  // Exact match first
  for (const cat of allCategories) {
    if (normalizeText(cat) === normalized) {
      const type: TransactionType = (INCOME_CATEGORIES as readonly string[]).includes(cat)
        ? 'income'
        : 'expense';
      return { category: cat, type };
    }
  }

  // Partial match (category starts with input or input starts with category)
  for (const cat of allCategories) {
    const normalizedCat = normalizeText(cat);
    if (normalizedCat.startsWith(normalized) || normalized.startsWith(normalizedCat)) {
      const type: TransactionType = (INCOME_CATEGORIES as readonly string[]).includes(cat)
        ? 'income'
        : 'expense';
      return { category: cat, type };
    }
  }

  return null;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse message in format: "Категория Сумма Комментарий"
 * Examples:
 *   "Продукты 1500 Пятёрочка"
 *   "Продукты 1500"
 *   "зарплата 80000"
 */
export function parseTransactionMessage(text: string): ParsedMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Split into parts: category, amount, comment (optional)
  // Strategy: find the number in the message, everything before is category, everything after is comment
  const parts = trimmed.split(/\s+/);

  let amountIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    const num = parseFloat(parts[i]!.replace(',', '.'));
    if (!isNaN(num) && num > 0) {
      amountIndex = i;
      break;
    }
  }

  if (amountIndex === -1) return null;

  const categoryPart = parts.slice(0, amountIndex).join(' ');
  const amount = parseFloat(parts[amountIndex]!.replace(',', '.'));
  const commentPart = parts.slice(amountIndex + 1).join(' ');

  if (!categoryPart || isNaN(amount) || amount <= 0) return null;

  const found = findCategory(categoryPart);

  if (!found) {
    return null;
  }

  return {
    transaction: {
      date: formatDate(new Date()),
      type: found.type,
      category: found.category,
      amount,
      comment: commentPart || '',
    },
    confidence: 'high',
  };
}

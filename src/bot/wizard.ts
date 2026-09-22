import { isExchange } from '../domain/exchange.js';
import type { Operation } from '../domain/operation.js';
import { findCategory, type Reference } from '../domain/reference.js';
import type { DraftView, WizardStep } from './drafts.js';

const STEPS: WizardStep[] = [
  'date',
  'type',
  'acc',
  'to',
  'amount',
  'received',
  'cat',
  'sub',
  'comment',
];

function applies(step: WizardStep, op: Operation, ref: Reference): boolean {
  switch (step) {
    case 'to':
      return op.type === 'Перевод';
    case 'received':
      return isExchange(op, ref);
    case 'cat':
      // Transfers get the Transfer category automatically
      return !(op.type === 'Перевод' && op.category);
    case 'sub':
      return (op.category ? (findCategory(ref, op.category)?.subcategories.length ?? 0) : 0) > 0;
    default:
      return true;
  }
}

function viewFor(step: WizardStep): DraftView {
  switch (step) {
    case 'amount':
    case 'received':
    case 'rate':
    case 'comment':
      return { kind: 'input', field: step, since: Date.now() };
    default:
      return { kind: 'pick', picker: step };
  }
}

/** View for the first applicable wizard step after `completed`, or the card when done. */
export function nextWizardView(completed: WizardStep, op: Operation, ref: Reference): DraftView {
  for (const step of STEPS.slice(STEPS.indexOf(completed) + 1)) {
    if (applies(step, op, ref)) return viewFor(step);
  }
  return { kind: 'card' };
}

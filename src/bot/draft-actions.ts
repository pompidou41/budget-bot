import { addDays, parseUserDate, todayIn } from '../domain/dates.js';
import { parseAmount } from '../domain/format.js';
import { normalizeOperation, OP_TYPES, type Operation } from '../domain/operation.js';
import { activeAccounts, findCategory, type Reference } from '../domain/reference.js';
import type { Draft, Picker, WizardStep } from './drafts.js';
import { nextWizardView } from './wizard.js';

const PICKERS: readonly string[] = ['acc', 'to', 'cat', 'sub', 'date', 'type'];
const MAX_DAYS_BACK = 7;
/** Column I holds a note, not a story; a longer text is almost always a paste gone wrong. */
export const MAX_COMMENT_LENGTH = 200;

/** Move the draft on after a field was filled: next wizard step, subcategory, or the card. */
function complete(draft: Draft, ref: Reference, step: WizardStep): void {
  if (draft.wizard) {
    draft.view = nextWizardView(step, draft.op, ref);
  } else if (
    step === 'cat' &&
    draft.op.category &&
    (findCategory(ref, draft.op.category)?.subcategories.length ?? 0) > 0
  ) {
    draft.view = { kind: 'pick', picker: 'sub' };
  } else {
    draft.view = { kind: 'card' };
  }
  if (draft.view.kind === 'card') draft.wizard = false;
}

function select(
  op: Operation,
  ref: Reference,
  picker: Picker,
  arg: string,
  timeZone: string,
): Operation | null {
  const index = Number(arg);
  switch (picker) {
    case 'acc': {
      const account = activeAccounts(ref)[index];
      return account ? { ...op, account: account.id } : null;
    }
    case 'to': {
      const account = activeAccounts(ref)[index];
      return account ? { ...op, toAccount: account.id } : null;
    }
    case 'cat': {
      const category = ref.categories[index];
      return category ? { ...op, category: category.name, subcategory: null } : null;
    }
    case 'sub': {
      const category = op.category ? findCategory(ref, op.category) : undefined;
      const subcategory = category?.subcategories[index];
      return subcategory ? { ...op, subcategory } : null;
    }
    case 'date':
      if (!Number.isInteger(index) || index > 0 || index < -MAX_DAYS_BACK) return null;
      return { ...op, date: addDays(todayIn(timeZone), index) };
    case 'type': {
      const type = OP_TYPES[index];
      return type ? { ...op, type } : null;
    }
  }
}

/**
 * Apply a card/wizard button press (`d:<id>:<action>[:<arg>]`).
 * Returns a short notice for the user if the press could not be applied.
 */
export function applyAction(
  draft: Draft,
  ref: Reference,
  action: string,
  arg: string | undefined,
  timeZone: string,
): string | null {
  if (action === 'back') {
    draft.view = { kind: 'card' };
    return null;
  }
  if (action === 'oneoff') {
    draft.op = { ...draft.op, oneOff: !draft.op.oneOff };
    return null;
  }
  if (action === 'skip') {
    draft.op = { ...draft.op, comment: '' };
    complete(draft, ref, 'comment');
    return null;
  }
  if (action === 'comment') {
    draft.view = { kind: 'input', field: 'comment', since: Date.now() };
    return null;
  }
  if (!PICKERS.includes(action)) return 'Неизвестная кнопка';

  const picker = action as Picker;
  if (arg === undefined) {
    draft.view = { kind: 'pick', picker };
    return null;
  }
  if (picker === 'date' && arg === 'in') {
    draft.view = { kind: 'input', field: 'date', since: Date.now() };
    return null;
  }

  const updated = select(draft.op, ref, picker, arg, timeZone);
  if (!updated) {
    draft.view = { kind: 'pick', picker };
    return 'Список обновился — выбери ещё раз';
  }
  draft.op = normalizeOperation(updated, ref);
  complete(draft, ref, picker);
  return null;
}

/** Apply typed text to the field the draft is waiting for. Returns an error hint or null. */
export function applyInput(
  draft: Draft,
  ref: Reference,
  text: string,
  timeZone: string,
): string | null {
  const { view } = draft;
  if (view.kind !== 'input') return null;

  switch (view.field) {
    case 'amount': {
      const amount = parseAmount(text);
      if (amount === null) return 'Не понял сумму — напиши число, например 1500 или 1,5к';
      // Typed in reply to "сумма в <валюта счёта>", so the currency question is settled
      draft.op = { ...draft.op, amount, mentionedCurrency: null };
      break;
    }
    case 'received': {
      const received = parseAmount(text);
      if (received === null) return 'Не понял сумму — напиши число, например 110 или 110,5';
      draft.op = { ...draft.op, received };
      break;
    }
    case 'comment': {
      const comment = text.trim();
      if (!comment) return 'Комментарий пустой — напиши текст или нажми «Назад»';
      if (comment.length > MAX_COMMENT_LENGTH) {
        return `Комментарий длиннее ${MAX_COMMENT_LENGTH} символов — сократи`;
      }
      draft.op = { ...draft.op, comment };
      break;
    }
    case 'date': {
      const date = parseUserDate(text, todayIn(timeZone));
      if (!date) return 'Не понял дату — например 05.09 или 2026-09-05';
      draft.op = { ...draft.op, date };
      break;
    }
  }

  complete(draft, ref, view.field);
  return null;
}

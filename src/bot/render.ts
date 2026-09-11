import type { InlineKeyboard } from 'grammy';
import { renderCard } from '../domain/card.js';
import { validate, type Operation } from '../domain/operation.js';
import { findAccount, type Reference } from '../domain/reference.js';
import type { Draft, InputField, Picker } from './drafts.js';
import { cardKeyboard, inputKeyboard, pickerKeyboard } from './keyboards.js';

function currency(ref: Reference, accountId: string | null): string {
  return (accountId && findAccount(ref, accountId)?.currency) || '';
}

function pickPrompt(picker: Picker, op: Operation): string {
  switch (picker) {
    case 'acc':
      return op.type === 'Доход' ? 'На какой счёт пришли деньги?' : 'С какого счёта?';
    case 'to':
      return 'На какой счёт?';
    case 'cat':
      return 'Категория?';
    case 'sub':
      return `Подкатегория ${op.category ?? ''}?`;
    case 'date':
      return 'Дата операции?';
    case 'type':
      return 'Тип операции?';
  }
}

function inputPrompt(field: InputField, op: Operation, ref: Reference): string {
  switch (field) {
    case 'amount':
      return `Сумма в ${currency(ref, op.account) || 'валюте счёта'} — напиши числом`;
    case 'received':
      return `Сколько пришло на ${op.toAccount ?? '?'} в ${currency(ref, op.toAccount)}?`;
    case 'comment':
      return 'Комментарий — напиши или пропусти';
    case 'date':
      return 'Дата — например 05.09 или 2026-09-05';
  }
}

/** Text and keyboard of the draft message for its current view. */
export function renderDraft(
  draft: Draft,
  ref: Reference,
  footer?: string,
): { text: string; keyboard: InlineKeyboard } {
  const { op, view } = draft;

  if (view.kind === 'card') {
    return {
      text: renderCard(op, ref, {
        problems: validate(op, ref),
        transcript: draft.transcript,
        note: draft.note,
        footer,
      }),
      keyboard: cardKeyboard(draft),
    };
  }

  const preview = renderCard(op, ref, { transcript: draft.transcript });
  if (view.kind === 'pick') {
    return {
      text: `${preview}\n\n👉 <b>${pickPrompt(view.picker, op)}</b>`,
      keyboard: pickerKeyboard(draft, view.picker, ref),
    };
  }
  return {
    text: `${preview}\n\n✏️ <b>${inputPrompt(view.field, op, ref)}</b>`,
    keyboard: inputKeyboard(draft, view.field),
  };
}

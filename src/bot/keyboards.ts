import { InlineKeyboard } from 'grammy';
import { OP_TYPES } from '../domain/operation.js';
import { activeAccounts, findCategory, type Reference } from '../domain/reference.js';
import type { Draft, InputField, Picker } from './drafts.js';

// Lists are addressed by index: callback_data is capped at 64 bytes and names may be Cyrillic
export function draftCallback(draftId: string, action: string, arg?: string | number): string {
  return arg === undefined ? `d:${draftId}:${action}` : `d:${draftId}:${action}:${arg}`;
}

export interface Button {
  label: string;
  data: string;
}

/** Buttons laid out `perRow` per row, with a trailing `.row()` so more can be appended. */
export function grid(buttons: Button[], perRow: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  buttons.forEach((button, i) => {
    keyboard.text(button.label, button.data);
    if ((i + 1) % perRow === 0) keyboard.row();
  });
  if (buttons.length % perRow !== 0) keyboard.row();
  return keyboard;
}

function withFooter(keyboard: InlineKeyboard, draft: Draft): InlineKeyboard {
  return draft.wizard
    ? keyboard.text('❌ Отмена', draftCallback(draft.id, 'cancel'))
    : keyboard.text('← Назад', draftCallback(draft.id, 'back'));
}

export function cardKeyboard(draft: Draft): InlineKeyboard {
  const cb = (action: string) => draftCallback(draft.id, action);
  const keyboard = new InlineKeyboard()
    .text('✅ Сохранить', cb('save'))
    .text('❌ Отмена', cb('cancel'))
    .row()
    .text('🏦 Счёт', cb('acc'));
  if (draft.op.type === 'Перевод') keyboard.text('➡️ Куда', cb('to'));
  return keyboard
    .text('📂 Категория', cb('cat'))
    .row()
    .text('📅 Дата', cb('date'))
    .text('🔀 Тип', cb('type'))
    .text(draft.op.oneOff ? '⚡ Разовая ✓' : '⚡ Разовая', cb('oneoff'));
}

function pickerButtons(draft: Draft, picker: Picker, ref: Reference): InlineKeyboard {
  const cb = (arg: string | number) => draftCallback(draft.id, picker, arg);

  switch (picker) {
    case 'acc':
    case 'to':
      return grid(
        activeAccounts(ref).flatMap((a, i) =>
          picker === 'to' && a.id === draft.op.account
            ? []
            : [{ label: `${a.id} · ${a.currency}`, data: cb(i) }],
        ),
        2,
      );
    case 'cat':
      return grid(
        ref.categories.map((c, i) => ({ label: c.name, data: cb(i) })),
        3,
      );
    case 'sub': {
      const category = draft.op.category ? findCategory(ref, draft.op.category) : undefined;
      return grid(
        (category?.subcategories ?? []).map((s, i) => ({ label: s, data: cb(i) })),
        2,
      );
    }
    case 'date':
      return new InlineKeyboard()
        .text('Сегодня', cb(0))
        .text('Вчера', cb(-1))
        .text('Позавчера', cb(-2))
        .row()
        .text('✏️ Другая дата', cb('in'))
        .row();
    case 'type':
      return grid(
        OP_TYPES.map((t, i) => ({ label: t, data: cb(i) })),
        3,
      );
  }
}

export function pickerKeyboard(draft: Draft, picker: Picker, ref: Reference): InlineKeyboard {
  return withFooter(pickerButtons(draft, picker, ref), draft);
}

export function inputKeyboard(draft: Draft, field: InputField): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (field === 'comment') keyboard.text('Пропустить', draftCallback(draft.id, 'skip')).row();
  return withFooter(keyboard, draft);
}

export function savedKeyboard(row: number): InlineKeyboard {
  return new InlineKeyboard().text('↩️ Отменить', `u:${row}`);
}

export function undoConfirmKeyboard(row: number): InlineKeyboard {
  return new InlineKeyboard().text('🗑 Удалить', `u:${row}`).text('Оставить', 'u:keep');
}

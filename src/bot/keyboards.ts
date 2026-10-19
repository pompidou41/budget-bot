import { InlineKeyboard } from 'grammy';
import type { ReviewScope } from '../analytics/signals.js';
import { categoryLabel } from '../domain/category-labels.js';
import { isExchange } from '../domain/exchange.js';
import { OP_TYPES } from '../domain/operation.js';
import { REVIEW_PREFIX, REVIEW_SCOPES } from '../domain/review.js';
import {
  COUNT_CHOICES,
  countLabel,
  currencyLabel,
  DEFAULT_REPORT,
  encodeReport,
  encodeReportImage,
  otherCurrency,
  otherSort,
  PICTURE_LABEL,
  sortLabel,
  toggleCategory,
  type ReportState,
} from '../domain/report.js';
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

export function cardKeyboard(draft: Draft, ref: Reference): InlineKeyboard {
  const cb = (action: string) => draftCallback(draft.id, action);
  const keyboard = new InlineKeyboard()
    .text('✅ Сохранить', cb('save'))
    .text('❌ Отмена', cb('cancel'))
    .row()
    .text('💰 Сумма', cb('amount'))
    .text('🏦 Счёт', cb('acc'));
  if (draft.op.type === 'Перевод') keyboard.text('➡️ Куда', cb('to'));
  if (isExchange(draft.op, ref)) {
    keyboard.row().text('💱 Курс', cb('rate')).text('📥 Пришло', cb('received'));
  }
  return keyboard
    .row()
    .text('📂 Категория', cb('cat'))
    .text('📅 Дата', cb('date'))
    .text('🔀 Тип', cb('type'))
    .row()
    .text(draft.op.oneOff ? '⚡ Разовая ✓' : '⚡ Разовая', cb('oneoff'))
    .text(draft.op.comment ? '💬 Изменить комментарий' : '💬 Комментарий', cb('comment'));
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
  if (field === 'comment') {
    // «Пропустить» clears the comment. Mid-wizard that is the point; from the card it would
    // silently erase the comment the owner came to edit, so removal is its own explicit button
    // and «← Назад» keeps whatever is there.
    if (draft.wizard) {
      keyboard.text('Пропустить', draftCallback(draft.id, 'skip')).row();
    } else if (draft.op.comment) {
      keyboard.text('🗑 Убрать комментарий', draftCallback(draft.id, 'skip')).row();
    }
  }
  return withFooter(keyboard, draft);
}

export function savedKeyboard(row: number): InlineKeyboard {
  return new InlineKeyboard().text('↩️ Отменить', `u:${row}`);
}

export function undoConfirmKeyboard(row: number): InlineKeyboard {
  return new InlineKeyboard().text('🗑 Удалить', `u:${row}`).text('Оставить', 'u:keep');
}

/** Offered when a message parsed into no operations: it was more likely a question. */
export function askInsteadKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🧠 Задать как вопрос', 'a:q');
}

/** Under a failed AI parse: runs the same input through the AI again, in the same message. */
export function retryKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🔁 Попробовать ещё раз', 'r:');
}

/**
 * Buttons for a `/report` screen in plain-HTML mode. In rich mode the same choices live
 * inside the message as `<tg-button>`, so this exists only for the fallback.
 */
export function reportKeyboard(state: ReportState, allCategories: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const enc = (next: Partial<ReportState>) => encodeReport({ ...state, ...next }, allCategories);
  const mark = (label: string, active: boolean) => (active ? `• ${label}` : label);

  keyboard
    .text(
      mark('Недели', state.period === 'bucket'),
      enc({ period: 'bucket', count: DEFAULT_REPORT.count }),
    )
    .text(mark('Месяцы', state.period === 'month'), enc({ period: 'month', count: 6 }))
    .row();

  for (const n of COUNT_CHOICES[state.period]) {
    keyboard.text(mark(countLabel(state.period, n), n === state.count), enc({ count: n }));
  }
  keyboard
    .row()
    .text(state.oneOff ? '− разовые' : '+ разовые', enc({ oneOff: !state.oneOff }))
    .text(currencyLabel(state), enc({ currency: otherCurrency(state) }))
    .text(sortLabel(state), enc({ sort: otherSort(state) }))
    .row()
    .text(PICTURE_LABEL, encodeReportImage(state, allCategories))
    .row();

  const selected = new Set(state.categories);
  const all = selected.size === 0;
  allCategories.forEach((name, i) => {
    const next = toggleCategory(state.categories, name, allCategories);
    keyboard.text(
      `${all || selected.has(name) ? '☑' : '☐'} ${categoryLabel(name)}`,
      enc({ categories: next }),
    );
    if (i % 2 === 1) keyboard.row();
  });

  if (!all) keyboard.row().text('Показать все', enc({ categories: [] }));
  return keyboard;
}

/**
 * Buttons under the report picture. Everything but «Таблица» carries the picture prefix, so
 * the picture is redrawn in place; «Таблица» sends the text screen with the same state as a new
 * message, leaving the picture where it is.
 */
export function photoKeyboard(state: ReportState, allCategories: string[]): InlineKeyboard {
  const enc = (next: Partial<ReportState>) =>
    encodeReportImage({ ...state, ...next }, allCategories);
  const mark = (label: string, active: boolean) => (active ? `• ${label}` : label);

  const keyboard = new InlineKeyboard();
  for (const n of COUNT_CHOICES[state.period]) {
    keyboard.text(mark(countLabel(state.period, n), n === state.count), enc({ count: n }));
  }
  return keyboard
    .row()
    .text(
      mark('Недели', state.period === 'bucket'),
      enc({ period: 'bucket', count: DEFAULT_REPORT.count }),
    )
    .text(mark('Месяцы', state.period === 'month'), enc({ period: 'month', count: 6 }))
    .row()
    .text('USD ⇄ RUB', enc({ currency: otherCurrency(state) }))
    .text('± разовые', enc({ oneOff: !state.oneOff }))
    .text(sortLabel(state), enc({ sort: otherSort(state) }))
    .row()
    .text('📊 Таблица', encodeReport(state, allCategories));
}

/** Period switch under a review in plain-HTML mode; rich mode draws it inside the message. */
export function reviewKeyboard(current: ReviewScope): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const { scope, label } of REVIEW_SCOPES) {
    keyboard.text(scope === current ? `• ${label}` : label, `${REVIEW_PREFIX}${scope}`);
  }
  return keyboard;
}

import { InlineKeyboard, Keyboard } from 'grammy';
import { EXPENSE_CATEGORIES } from '../../config/categories.js';

export function confirmTransactionKeyboard(confirmed = false): InlineKeyboard {
  if (confirmed) {
    return new InlineKeyboard();
  }

  return new InlineKeyboard()
    .text('Сохранить', 'tx:confirm')
    .text('Изменить категорию', 'tx:change_cat')
    .row()
    .text('Отмена', 'tx:cancel');
}

export function categorySelectionKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < EXPENSE_CATEGORIES.length; i++) {
    const cat = EXPENSE_CATEGORIES[i]!;
    keyboard.text(cat, `cat:${cat}`);
    if (i % 2 === 1) keyboard.row();
  }

  keyboard.row().text('← Назад', 'tx:back');

  return keyboard;
}

export function summaryPeriodKeyboard(backCallback?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('Текущая неделя', 'summary:week')
    .text('Текущий месяц', 'summary:month')
    .row()
    .text('Прошлый месяц', 'summary:prev_month')
    .text('За всё время', 'summary:all');

  if (backCallback) {
    kb.row().text('← Назад', backCallback);
  }

  return kb;
}

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Саммари', 'menu:summary')
    .text('Все траты', 'menu:expenses')
    .row()
    .text('Все доходы', 'menu:income')
    .text('Последние записи', 'menu:recent');
}

export const MENU_BUTTON_LABEL = '📋 Меню';

export function mainReplyKeyboard(): Keyboard {
  return new Keyboard()
    .text(MENU_BUTTON_LABEL)
    .persistent()
    .resized()
    .placeholder('Категория Сумма Комментарий');
}

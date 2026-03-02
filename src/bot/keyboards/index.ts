import { InlineKeyboard } from 'grammy';

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

export function categorySelectionKeyboard(categories: readonly string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    keyboard.text(cat, `cat:${cat}`);
    if (i % 2 === 1) keyboard.row();
  }

  keyboard.row().text('← Назад', 'tx:back');

  return keyboard;
}

export function periodKeyboard(prefix: string, backCallback?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('Текущая неделя', `${prefix}week`)
    .text('Текущий месяц', `${prefix}month`)
    .row()
    .text('Прошлый месяц', `${prefix}prev_month`)
    .text('За всё время', `${prefix}all`);

  if (backCallback) {
    kb.row().text('← Назад', backCallback);
  }

  return kb;
}

export function summaryPeriodKeyboard(backCallback?: string): InlineKeyboard {
  return periodKeyboard('summary:', backCallback);
}

export function expensesPeriodKeyboard(): InlineKeyboard {
  return periodKeyboard('expenses:', 'nav:reports');
}

export function incomePeriodKeyboard(): InlineKeyboard {
  return periodKeyboard('income:', 'nav:reports');
}

export function recentPeriodKeyboard(): InlineKeyboard {
  return periodKeyboard('recent:', 'nav:reports');
}

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Отчёты', 'nav:reports')
    .text('⚙️ Настройки', 'nav:settings')
    .row()
    .text('💸 Операции', 'nav:operations')
    .text('❓ Справка', 'nav:help');
}

export function reportsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Саммари за период', 'nav:summary')
    .row()
    .text('Все траты', 'nav:expenses')
    .text('Все доходы', 'nav:income')
    .row()
    .text('Последние записи', 'nav:recent')
    .row()
    .text('← Назад', 'nav:main_menu');
}

export function settingsMenuKeyboard(sheetUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Список категорий', 'nav:categories')
    .row()
    .url('🔗 Google-таблица', sheetUrl)
    .row()
    .text('← Назад', 'nav:main_menu');
}

export function operationsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Добавить операцию', 'menu:add_tx')
    .row()
    .text('↩️ Отменить последнюю', 'op:undo')
    .row()
    .text('← Назад', 'nav:main_menu');
}

export function registrationAddedKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Добавил ✅', 'reg:added')
    .row()
    .text('Не могу добавить ❌', 'reg:cant_add');
}

export function categoriesConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Да, сходится ✅', 'reg:cats_ok')
    .row()
    .text('Нет, использовать стандартные ❌', 'reg:cats_default');
}

export function wizardDateKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Сегодня', 'wzd:date_today')
    .text('Вчера', 'wzd:date_yesterday')
    .row()
    .text('Другая дата', 'wzd:date_custom');
}

export function wizardTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Расход 📉', 'wzd:type_expense')
    .text('Доход 📈', 'wzd:type_income');
}

export function wizardCategoryKeyboard(categories: readonly string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    keyboard.text(cat, `wzd:cat:${cat}`);
    if (i % 2 === 1) keyboard.row();
  }

  return keyboard;
}

export function wizardCommentKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('Пропустить', 'wzd:skip_comment');
}

export function undoConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('Удалить ✅', 'undo:confirm').text('Отмена ❌', 'undo:cancel');
}

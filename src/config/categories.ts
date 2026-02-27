export const EXPENSE_CATEGORIES = [
  'Квартира',
  'КУ',
  'Продукты',
  'Еда вне дома',
  'Здоровье и уход',
  'Развлечения',
  'Подписки, связь, интернет',
  'Транспорт',
  'Автомобиль',
  'Топливо',
  'Бензин',
  'Газ',
  'ТО',
  'Такси',
  'Покупки',
  'Семья, друзья',
  'Лиза',
  'Кредиты',
  'Машина',
  'Учеба',
  'Сессия',
  'Дал в долг',
  'Прочее',
] as const;

export const INCOME_CATEGORIES = [
  'Зарплата',
  'Фриланс',
  'Подарок',
  'Возврат долга',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export type TransactionType = 'expense' | 'income';

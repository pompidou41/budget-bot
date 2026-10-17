/** Russian names of the top-level categories of «Categories» (the sheet itself keeps English ones). */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  Housing: 'Жильё',
  Food: 'Еда',
  Transport: 'Транспорт',
  Health: 'Здоровье',
  Personal: 'Личное',
  Subscriptions: 'Подписки',
  Entertainment: 'Развлечения',
  Travel: 'Путешествия',
  Education: 'Обучение',
  Family: 'Семья',
  Liza: 'Лиза',
  Finance: 'Финансы',
  Investments: 'Инвестиции',
  Other: 'Прочее',
  Income: 'Доходы',
  Transfer: 'Переводы',
};

/** Russian label of a top-level category; a category the map doesn't know keeps its own name. */
export function categoryLabel(name: string): string {
  return Object.hasOwn(CATEGORY_LABELS, name) ? (CATEGORY_LABELS[name] ?? name) : name;
}

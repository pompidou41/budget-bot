export interface UserRecord {
  telegramId: number;
  sheetId: string;
  sheetUrl: string;
  expenseCategories: string[];
  incomeCategories: string[];
  categoriesSource: 'parsed' | 'default';
  registeredAt: string;
  updatedAt: string;
}

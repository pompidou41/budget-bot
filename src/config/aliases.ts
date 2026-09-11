/**
 * How the owner refers to accounts in messages. Keys are IDs from the «Счета» sheet.
 * The AI also sees each account's name and bank, so list only non-obvious names.
 * Unknown IDs are ignored; new accounts work without an entry here.
 */
export const ACCOUNT_ALIASES: Record<string, string[]> = {
  T_MAIN: ['тинькофф', 'тинёк', 'тинек', 'т-банк', 'тбанк', 'основная карта'],
  T_CC: ['кредитка', 'кредитка тинька', 'платинум'],
  T_CONST: ['постоянные', 'постоянные расходы'],
  T_MONTHLY: ['расходы месяца', 'месячные'],
  // «накопительный» без банка намеренно не алиас: так называются и T_SACC, и REN_SAVE
  T_SACC: ['накопительный тинька', 'накопительный т-банк'],
  T_CAR: ['на машину', 'копилка на машину'],
  T_SAVE: ['подушка'],
  T_HOUSE: ['на жильё', 'на квартиру'],
  T_INVEST: ['акции', 'брокерский'],
  ALFA_MAIN: ['альфа', 'альфабанк', 'альфа-банк'],
  GAZ_MAIN: ['газпром', 'газпромбанк', 'гпб'],
  GAZ_LOAN: ['автокредит'],
  REN_LOAN: ['кредит на учёбу', 'учебный кредит'],
  REN_SAVE: ['ренессанс', 'накопительный ренессанс'],
  CASH_RUB: ['наличные', 'нал', 'налом', 'кэш'],
  WTP_MAIN: ['easy card', 'изи карта', 'wanttopay'],
  MC_MAIN: ['sg card', 'сг карта'],
  BYBIT_USDT: ['байбит', 'bybit'],
};

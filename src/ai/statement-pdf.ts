import { z } from 'zod/v4';
import {
  parseMoney,
  parseStatementDate,
  purchaseDate,
  StatementFormatError,
  type Statement,
  type StatementRow,
} from '../statement/statement.js';
import { completeJson, type JsonSchemaSpec, type OpenRouterOptions } from './openrouter.js';

/** A long statement is many thousand output tokens; the default minute is not enough. */
const EXTRACT_TIMEOUT_MS = 240_000;

const rowSchema = z.object({
  date: z.string(),
  operation: z.string().catch(''),
  debit: z.number().catch(0),
  credit: z.number().catch(0),
  balance: z.string().catch(''),
  description: z.string().catch(''),
  counterparty: z.string().catch(''),
  counterpartyAccount: z.string().catch(''),
});

const extractSchema = z.object({
  holder: z.string().catch(''),
  iban: z.string().catch(''),
  currency: z.string().catch(''),
  opening: z.string().catch(''),
  closing: z.string().catch(''),
  rows: z.array(z.unknown()).catch([]),
});

const text = (description: string) => ({ type: 'string', description });

const SCHEMA: JsonSchemaSpec = {
  name: 'statement',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(extractSchema.shape),
    properties: {
      holder: text('Владелец счёта, как напечатан'),
      iban: text('Номер счёта (IBAN) без пробелов'),
      currency: text('ISO-код валюты счёта'),
      opening: text('Начальный остаток числом, или пустая строка'),
      closing: text('Конечный остаток числом, или пустая строка'),
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(rowSchema.shape),
          properties: {
            date: text('Дата строки как напечатана: DD.MM.YYYY'),
            operation: text('Вид операции дословно'),
            debit: { type: 'number', description: 'Списание (Turnover DB), 0 если нет' },
            credit: { type: 'number', description: 'Зачисление (Turnover Cr), 0 если нет' },
            balance: text('Остаток после строки числом, или пустая строка'),
            description: text('Описание дословно, на языке выписки'),
            counterparty: text('Получатель или отправитель дословно, или пустая строка'),
            counterpartyAccount: text('Счёт контрагента, или пустая строка'),
          },
        },
      },
    },
  },
};

const PROMPT = `Перепиши банковскую выписку из PDF в JSON — дословно, ничего не придумывая и не пропуская.
Каждая строка таблицы операций — один объект rows, в том же порядке, что в выписке.
Суммы — числа с точкой: «1,140.84» → 1140.84. Текст (в том числе грузинский) переписывай как есть, не переводи.
Итоговые строки и шапку таблицы в rows не включай.`;

function toRows(raw: unknown[]): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const item of raw) {
    const parsed = rowSchema.safeParse(item);
    if (!parsed.success) continue;
    const row = parsed.data;
    const postedDate = parseStatementDate(row.date);
    const out = row.debit > 0;
    if (!postedDate || (!out && !(row.credit > 0))) continue;
    rows.push({
      index: rows.length + 1,
      postedDate,
      date: purchaseDate(row.description) ?? postedDate,
      direction: out ? 'out' : 'in',
      amount: out ? row.debit : row.credit,
      balance: parseMoney(row.balance),
      operation: row.operation.trim(),
      description: row.description.trim(),
      counterparty: row.counterparty.trim(),
      counterpartyAccount: row.counterpartyAccount.trim(),
    });
  }
  return rows;
}

export interface StatementExtractor {
  /** Reads a statement PDF; the result must still pass verifyBalances before it is trusted. */
  extract(file: { filename: string; dataUrl: string }): Promise<Statement>;
}

export function createStatementExtractor(options: OpenRouterOptions): StatementExtractor {
  return {
    async extract(file) {
      const response = await completeJson(
        { ...options, timeoutMs: EXTRACT_TIMEOUT_MS },
        [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Выписка:' },
              { type: 'file', file: { filename: file.filename, file_data: file.dataUrl } },
            ],
          },
        ],
        SCHEMA,
      );
      const raw = extractSchema.parse(response);
      const rows = toRows(raw.rows);
      if (rows.length === 0) throw new StatementFormatError('В PDF не нашёл ни одной операции');
      const currency = raw.currency.trim().toUpperCase();
      if (!/^[A-Z]{3,4}$/.test(currency)) {
        throw new StatementFormatError('Не нашёл валюту счёта в выписке');
      }
      return {
        holder: raw.holder.trim(),
        iban: raw.iban.replace(/\s/g, ''),
        currency,
        from: null,
        to: null,
        opening: parseMoney(raw.opening),
        closing: parseMoney(raw.closing),
        rows,
      };
    },
  };
}

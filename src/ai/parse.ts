import { z } from 'zod/v4';
import { isIsoDate, todayIn } from '../domain/dates.js';
import { normalizeOperation, OP_TYPES, type Operation } from '../domain/operation.js';
import { activeAccounts, type Reference } from '../domain/reference.js';
import type { Note } from '../domain/settings.js';
import { buildSystemPrompt } from './parse-prompt.js';

export { buildSystemPrompt };
import {
  completeJson,
  type ContentPart,
  type JsonSchemaSpec,
  type OpenRouterOptions,
} from './openrouter.js';

// Sentinel instead of null/"" in enums: portable across providers' strict JSON-schema modes
export const NONE = 'NONE';
const PAIR_SEPARATOR = ' / ';
const MAX_OPERATIONS = 10;

export interface CategoryPair {
  category: string;
  subcategory: string | null;
}

function pairKey(category: string, subcategory: string | null): string {
  return subcategory ? `${category}${PAIR_SEPARATOR}${subcategory}` : category;
}

/** "Category / Subcategory" → pair. One enum of pairs guarantees a valid combination. */
export function categoryPairs(ref: Reference): Map<string, CategoryPair> {
  const pairs = new Map<string, CategoryPair>();
  for (const { name, subcategories } of ref.categories) {
    if (subcategories.length === 0) pairs.set(name, { category: name, subcategory: null });
    for (const sub of subcategories) {
      pairs.set(pairKey(name, sub), { category: name, subcategory: sub });
    }
  }
  return pairs;
}

// Lenient on purpose: the json_object fallback may omit fields or return nulls
const aiOperationSchema = z.object({
  date: z.string().catch(''),
  type: z.enum(OP_TYPES).catch('Расход'),
  account: z.string().catch(NONE),
  amount: z.number().catch(0),
  currency: z.string().catch(''),
  toAccount: z.string().catch(NONE),
  received: z.number().catch(0),
  category: z.string().catch(NONE),
  comment: z.string().catch(''),
  oneOff: z.boolean().catch(false),
  manualRate: z.number().catch(0),
});

export const aiResponseSchema = z.object({
  operations: z.array(aiOperationSchema).catch([]),
  note: z.string().catch(''),
});

export type AiOperation = z.infer<typeof aiOperationSchema>;

export function buildResponseSchema(ref: Reference): JsonSchemaSpec {
  const accountIds = [NONE, ...activeAccounts(ref).map((a) => a.id)];
  const categories = [NONE, ...categoryPairs(ref).keys()];

  const operation = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(aiOperationSchema.shape),
    properties: {
      date: { type: 'string', description: 'Дата операции, YYYY-MM-DD' },
      type: { type: 'string', enum: [...OP_TYPES] },
      account: {
        type: 'string',
        enum: accountIds,
        description: 'ID счёта списания (для дохода — зачисления) или NONE',
      },
      amount: { type: 'number', description: 'Сумма > 0 в валюте счёта, 0 если не названа' },
      currency: {
        type: 'string',
        description: 'ISO-код валюты, в которой названа сумма, или пустая строка',
      },
      toAccount: {
        type: 'string',
        enum: accountIds,
        description: 'Только для перевода: ID счёта получения, иначе NONE',
      },
      received: {
        type: 'number',
        description: 'Только для перевода: сколько пришло в валюте toAccount, 0 если не названо',
      },
      category: {
        type: 'string',
        enum: categories,
        description: '"Категория / Подкатегория" или NONE',
      },
      comment: { type: 'string', description: 'Короткий комментарий по-русски' },
      oneOff: { type: 'boolean', description: 'Крупная нетипичная трата' },
      manualRate: { type: 'number', description: 'Курс операции, если назван явно, иначе 0' },
    },
  };

  return {
    name: 'operations',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['operations', 'note'],
      properties: {
        operations: { type: 'array', items: operation },
        note: {
          type: 'string',
          description: 'Пояснение для пользователя, если что-то неоднозначно, иначе пустая строка',
        },
      },
    },
  };
}

export function fromAiOperation(raw: AiOperation, ref: Reference, today: string): Operation {
  const accountIds = new Set(activeAccounts(ref).map((a) => a.id));
  const pair = categoryPairs(ref).get(raw.category);
  const currency = raw.currency.trim().toUpperCase();

  return normalizeOperation(
    {
      date: isIsoDate(raw.date) ? raw.date : today,
      type: raw.type,
      account: accountIds.has(raw.account) ? raw.account : null,
      amount: raw.amount > 0 ? raw.amount : null,
      toAccount: accountIds.has(raw.toAccount) ? raw.toAccount : null,
      received: raw.received > 0 ? raw.received : null,
      category: pair?.category ?? null,
      subcategory: pair?.subcategory ?? null,
      comment: raw.comment.trim(),
      oneOff: raw.oneOff,
      manualRate: raw.manualRate > 0 ? raw.manualRate : null,
      mentionedCurrency: currency || null,
    },
    ref,
  );
}

export function toAiOperation(op: Operation): AiOperation {
  return {
    date: op.date,
    type: op.type,
    account: op.account ?? NONE,
    amount: op.amount ?? 0,
    currency: op.mentionedCurrency ?? '',
    toAccount: op.toAccount ?? NONE,
    received: op.received ?? 0,
    category: op.category ? pairKey(op.category, op.subcategory) : NONE,
    comment: op.comment,
    oneOff: op.oneOff,
    manualRate: op.manualRate ?? 0,
  };
}

export interface ParseInput {
  text?: string;
  imageDataUrl?: string;
}

export interface ParseResult {
  operations: Operation[];
  note: string | null;
}

export interface Parser {
  parse(input: ParseInput, ref: Reference, notes?: Note[]): Promise<ParseResult>;
  /** Apply a free-form correction ("это было вчера") to an existing draft. */
  edit(
    current: Operation,
    instruction: string,
    ref: Reference,
    notes?: Note[],
  ): Promise<ParseResult>;
}

export function createParser(options: OpenRouterOptions & { timeZone: string }): Parser {
  async function run(
    ref: Reference,
    notes: Note[],
    content: string | ContentPart[],
  ): Promise<ParseResult> {
    const today = todayIn(options.timeZone);
    const response = await completeJson(
      options,
      [
        { role: 'system', content: buildSystemPrompt(ref, today, notes) },
        { role: 'user', content },
      ],
      buildResponseSchema(ref),
    );
    const raw = aiResponseSchema.parse(response);

    return {
      operations: raw.operations
        .slice(0, MAX_OPERATIONS)
        .map((op) => fromAiOperation(op, ref, today)),
      note: raw.note.trim() || null,
    };
  }

  return {
    parse(input, ref, notes = []) {
      const text = input.text?.trim() ?? '';
      if (!input.imageDataUrl) return run(ref, notes, text);
      return run(ref, notes, [
        {
          type: 'text',
          text: text || 'Разбери операции на изображении (чек, скриншот банка или уведомления).',
        },
        { type: 'image_url', image_url: { url: input.imageDataUrl } },
      ]);
    },

    edit(current, instruction, ref, notes = []) {
      return run(
        ref,
        notes,
        [
          'Текущая операция (JSON):',
          JSON.stringify(toAiOperation(current)),
          '',
          `Правка пользователя: ${instruction}`,
          '',
          'Верни ровно одну операцию — текущую с применённой правкой. ' +
            'Поля, которых правка не касается, оставь как есть.',
        ].join('\n'),
      );
    },
  };
}

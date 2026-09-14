import { z } from 'zod/v4';
import { ACCOUNT_ALIASES } from '../config/aliases.js';
import { isIsoDate, todayIn, weekday } from '../domain/dates.js';
import { normalizeOperation, OP_TYPES, type Operation } from '../domain/operation.js';
import { activeAccounts, type Reference } from '../domain/reference.js';
import type { Note } from '../domain/settings.js';
import {
  completeJson,
  type ContentPart,
  type JsonSchemaSpec,
  type OpenRouterOptions,
} from './openrouter.js';

// Sentinel instead of null/"" in enums: portable across providers' strict JSON-schema modes
const NONE = 'NONE';
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

/** The owner's notes from /settings — words, people, accounts, rules — rendered for the prompt. */
function notesBlock(notes: Note[]): string {
  if (notes.length === 0) return '';
  const lines = notes.map((note) => `- ${note.text.replace(/\s*\n\s*/g, ' ')}`).join('\n');
  return `
Заметки владельца — его слова, люди, счета и правила. Он написал их сам, они важнее общих догадок.
Применяй их к тексту, расшифровке голоса и надписям на скриншотах:
${lines}
`;
}

export function buildSystemPrompt(ref: Reference, today: string, notes: Note[] = []): string {
  const accounts = activeAccounts(ref)
    .map((a) =>
      [a.id, a.name, a.bank, a.type, a.currency, (ACCOUNT_ALIASES[a.id] ?? []).join(', ')].join(
        ' | ',
      ),
    )
    .join('\n');
  const categories = ref.categories
    .map((c) => `${c.name}: ${c.subcategories.join(', ') || '—'}`)
    .join('\n');

  return `Ты разбираешь личные финансовые операции владельца для Google-таблицы учёта.
Пользователь пишет или диктует свободным текстом, иногда присылает фото чека или скриншот банка.
Сегодня ${today} (${weekday(today)}).

Верни JSON строго по схеме. Одно событие — одна операция; несколько трат в сообщении — несколько операций.
Если операций нет (приветствие, вопрос) — пустой массив и пояснение в note.

Типы:
- Расход — деньги ушли со счёта account наружу.
- Доход — деньги пришли на счёт account извне.
- Перевод — движение между СВОИМИ счетами: обмен валют, покупка/продажа USDT, пополнение накоплений, погашение кредитки или кредита, снятие наличных. account — откуда, toAccount — куда. Категория обычно Transfer / …

Правила полей:
- date: "вчера", "в понедельник", "5-го" считай от сегодняшней даты. Не названа — сегодня.
- account / toAccount: ID из списка счетов, только если счёт назван явно — по ID, названию, банку или алиасу, либо однозначно задан валютой (в списке ровно один счёт в названной валюте, например единственный USDT-счёт). Иначе — NONE. НИКОГДА не угадывай счёт.
- amount: число > 0 в валюте счёта. "1.5к", "полторы тысячи" = 1500. Не названа — 0.
- currency: валюта, в которой в итоге выражен amount ("$", "долларов", "usdt", "руб"), иначе пустая строка. Без курса сумму в другую валюту не пересчитывай.
- Если сумма названа в другой валюте вместе с курсом ("купил 214,56 usdt по 89,95 с тинька"): amount = сумма × курс в валюте счёта, округлённая до сотых; received = сумма в валюте получения; manualRate = курс; currency = валюта счёта.
- Цепочка "купил, потом вывел, по факту пришло N" — отдельные переводы; "пришло N" — это received последнего перевода.
- received: для перевода — сколько пришло на toAccount в его валюте, если названо (при обмене валют обязательно). Иначе 0.
- category: самая подходящая пара "Категория / Подкатегория" из списка. Если совсем непонятно — NONE.
- comment: коротко по-русски, что это было (магазин, назначение), без суммы и даты. Можно пустым.
- oneOff: true только для крупных нетипичных трат (техника, курсы, мебель, разовая поездка). Обычные траты — false.
- manualRate: только если назван курс именно этой операции (для RUB — рублей за 1 USD). Иначе 0.
- note: пустая строка или коротко пользователю, если что-то неоднозначно.

Фото и скриншоты (чеки, списки операций банковских приложений):
- В банковских приложениях список идёт от новых к старым: САМАЯ ВЕРХНЯЯ строка — самая свежая операция, чем ниже — тем раньше.
- Заголовок с датой («Сегодня», «Вчера», «10 сентября») относится к операциям НИЖЕ него — до следующего заголовка, а не выше.
- Возвращай операции в том же порядке, в каком они на экране, сверху вниз.
- У операции без даты и без заголовка выше дата — сегодняшняя.
- Не путай остаток счёта, итог за период или кэшбэк с суммой операции.
- Знак в приложении задаёт тип: «−» — расход, «+» — доход или поступление; перевод между своими счетами — Перевод.
${notesBlock(notes)}
Счета (ID | название | банк | тип | валюта | алиасы):
${accounts}

Категории (категория: подкатегории):
${categories}`;
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

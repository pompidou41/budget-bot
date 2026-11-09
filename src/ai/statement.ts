import { z } from 'zod/v4';
import { OP_TYPES } from '../domain/operation.js';
import { activeAccounts, findAccount, type Reference } from '../domain/reference.js';
import type { Note } from '../domain/settings.js';
import type { RowGuess } from '../statement/plan.js';
import type { StatementRow } from '../statement/statement.js';
import { completeJson, type JsonSchemaSpec, type OpenRouterOptions } from './openrouter.js';
import { categoryPairs, NONE } from './parse.js';

/** Rows per request: small enough for a fast model to answer within its timeout. */
const BATCH_SIZE = 40;
/** Batches in flight at once; more only trips the provider's rate limit. */
const PARALLEL = 3;

export interface StatementContext {
  account: string;
  holder: string;
  /** «Agrohub → Расход · Food / Groceries» — how the owner booked similar rows before. */
  history: string[];
  notes: Note[];
}

const guessSchema = z.object({
  index: z.number().int(),
  type: z.enum(OP_TYPES).catch('Расход'),
  counterAccount: z.string().catch(NONE),
  category: z.string().catch(NONE),
  comment: z.string().catch(''),
  sure: z.boolean().catch(false),
});

// A malformed row is dropped on its own; it then simply goes to the owner as unclassified
const responseSchema = z.object({ rows: z.array(z.unknown()).catch([]) });

function buildSchema(ref: Reference): JsonSchemaSpec {
  const accounts = [NONE, ...activeAccounts(ref).map((a) => a.id)];
  const row = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(guessSchema.shape),
    properties: {
      index: { type: 'integer', description: 'Номер строки из запроса (#N)' },
      type: { type: 'string', enum: [...OP_TYPES] },
      counterAccount: { type: 'string', enum: accounts, description: 'Только для перевода' },
      category: { type: 'string', enum: [NONE, ...categoryPairs(ref).keys()] },
      comment: { type: 'string', description: 'Коротко: магазин, сервис, человек' },
      sure: { type: 'boolean', description: 'false, если тип или категория под вопросом' },
    },
  };
  return {
    name: 'statement_rows',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['rows'],
      properties: { rows: { type: 'array', items: row } },
    },
  };
}

function buildStatementPrompt(context: StatementContext, ref: Reference): string {
  const own = findAccount(ref, context.account);
  const accounts = activeAccounts(ref)
    .map((a) => [a.id, a.name, a.bank, a.type, a.currency].join(' | '))
    .join('\n');
  const categories = ref.categories
    .map((c) => `${c.name}: ${c.subcategories.join(', ') || '—'}`)
    .join('\n');
  const notes = context.notes.map((n) => `- ${n.text.replace(/\s*\n\s*/g, ' ')}`).join('\n');

  return `Ты раскладываешь строки банковской выписки по таблице личного учёта.
Выписка счёта ${context.account} (${own?.bank ?? ''}, ${own?.currency ?? ''}), владелец — ${context.holder || 'владелец таблицы'}.
Строка: #номер | дата | out (списание) или in (зачисление) | сумма | вид операции | описание | контрагент | счёт контрагента.
Верни по объекту на КАЖДУЮ строку, index = номер строки.

- type: out — Расход или Перевод; in — Доход или Перевод.
- Перевод — только между СВОИМИ счетами владельца: контрагент — сам владелец, конвертация валюты
  (უნაღდო კონვერტაცია, Currency Exchange) на свой счёт в другой валюте, вывод с биржи или пополнение со своего счёта.
  Деньги людям и от людей — Расход и Доход, даже если это близкие.
- counterAccount: для перевода — ID второго своего счёта (out — куда, in — откуда), если он ясен; иначе NONE.
- category: пара «Категория / Подкатегория» из списка; NONE, если не понять.
- comment: коротко, как владелец пишет сам (см. историю): название магазина или сервиса латиницей
  либо по-русски, имя человека по-русски. Без суммы и даты. Грузинский переводи.
- sure: false, если тип или категория — догадка (непонятный продавец, перевод без пояснения).

Виды операций: საბარათე ოპერაცია — оплата картой; გადახდები — оплата счетов (связь, коммуналка);
გადარიცხვა … კლიენტებს შორის — перевод клиенту того же банка; სხვა ბანკიდან ჩარიცხვა — поступление из другого банка;
უნაღდო კონვერტაცია — конвертация валюты; მიმდინარე ანგარიშის საკომისიო — комиссия за счёт.
Слова: გადახდა — оплата, ელ.ენერგია — электричество, წყალი — вода, დასუფთავება — вывоз мусора, მობილური — мобильная связь.
${notes ? `\nЗаметки владельца — важнее догадок:\n${notes}\n` : ''}
${context.history.length > 0 ? `\nКак владелец записывал похожее раньше (комментарий → тип · категория):\n${context.history.join('\n')}\n` : ''}
Счета (ID | название | банк | тип | валюта):
${accounts}

Категории:
${categories}`;
}

function formatRows(rows: StatementRow[]): string {
  return rows
    .map((r) =>
      [
        `#${r.index}`,
        r.date,
        r.direction,
        r.amount,
        r.operation,
        r.description,
        r.counterparty,
        r.counterpartyAccount,
      ].join(' | '),
    )
    .join('\n');
}

function toGuess(raw: z.infer<typeof guessSchema>, ref: Reference): RowGuess {
  const pair = categoryPairs(ref).get(raw.category);
  const known = activeAccounts(ref).some((a) => a.id === raw.counterAccount);
  return {
    type: raw.type,
    counterAccount: known ? raw.counterAccount : null,
    category: pair?.category ?? null,
    subcategory: pair?.subcategory ?? null,
    comment: raw.comment.trim().slice(0, 120),
    sure: raw.sure && Boolean(pair),
  };
}

export interface StatementClassifier {
  /** One guess per row, keyed by StatementRow.index; rows the model skipped are absent. */
  classify(
    rows: StatementRow[],
    context: StatementContext,
    ref: Reference,
  ): Promise<Map<number, RowGuess>>;
}

export function createStatementClassifier(options: OpenRouterOptions): StatementClassifier {
  async function batch(rows: StatementRow[], system: string, ref: Reference) {
    const response = await completeJson(
      options,
      [
        { role: 'system', content: system },
        { role: 'user', content: formatRows(rows) },
      ],
      buildSchema(ref),
    );
    return responseSchema.parse(response).rows.flatMap((raw) => {
      const parsed = guessSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  return {
    async classify(rows, context, ref) {
      const system = buildStatementPrompt(context, ref);
      const batches: StatementRow[][] = [];
      for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

      const guesses = new Map<number, RowGuess>();
      const wanted = new Set(rows.map((r) => r.index));
      for (let i = 0; i < batches.length; i += PARALLEL) {
        const answers = await Promise.all(
          batches.slice(i, i + PARALLEL).map((b) => batch(b, system, ref)),
        );
        for (const raw of answers.flat()) {
          if (wanted.has(raw.index)) guesses.set(raw.index, toGuess(raw, ref));
        }
      }
      return guesses;
    },
  };
}

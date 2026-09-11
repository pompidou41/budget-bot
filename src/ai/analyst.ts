import { z } from 'zod/v4';
import { buildDigest } from '../analytics/digest.js';
import type { Txn } from '../analytics/dataset.js';
import { findTxns, type TxnQuery } from '../analytics/queries.js';
import type { Answer } from '../domain/answer.js';
import { todayIn } from '../domain/dates.js';
import type { Reference } from '../domain/reference.js';
import type { Alias } from '../domain/settings.js';
import { logger } from '../logger.js';
import {
  completeJson,
  type ChatMessage,
  type JsonSchemaSpec,
  type OpenRouterOptions,
} from './openrouter.js';

/** Rounds of "ask for raw rows → get them" before the model must answer. */
const MAX_ROUNDS = 3;
const MAX_QUERIES_PER_ROUND = 3;
const MAX_SECTIONS = 4;
const MAX_BULLETS = 6;
const MAX_SERIES = 24;

// Lenient on purpose: the json_object fallback may omit fields or return nulls
const querySchema = z.object({
  from: z.string().catch(''),
  to: z.string().catch(''),
  type: z.string().catch(''),
  category: z.string().catch(''),
  subcategory: z.string().catch(''),
  account: z.string().catch(''),
  search: z.string().catch(''),
  minUsd: z.number().catch(0),
  limit: z.number().catch(20),
});

export const analystResponseSchema = z.object({
  action: z.enum(['answer', 'query']).catch('answer'),
  queries: z.array(querySchema).catch([]),
  headline: z.string().catch(''),
  sections: z
    .array(
      z.object({
        title: z.string().catch(''),
        bullets: z.array(z.string().catch('')).catch([]),
      }),
    )
    .catch([]),
  seriesTitle: z.string().catch(''),
  seriesUnit: z.string().catch('$'),
  series: z.array(z.object({ label: z.string().catch(''), value: z.number().catch(0) })).catch([]),
  note: z.string().catch(''),
});

type AnalystResponse = z.infer<typeof analystResponseSchema>;

export function toAnswer(raw: AnalystResponse): Answer {
  return {
    headline: raw.headline.trim(),
    sections: raw.sections.slice(0, MAX_SECTIONS).map((section) => ({
      title: section.title.trim(),
      bullets: section.bullets.slice(0, MAX_BULLETS).map((bullet) => bullet.trim()),
    })),
    seriesTitle: raw.seriesTitle.trim(),
    seriesUnit: raw.seriesUnit.trim() || '$',
    series: raw.series.slice(0, MAX_SERIES).map((point) => ({
      label: point.label.trim(),
      value: point.value,
    })),
    note: raw.note.trim(),
  };
}

const RESPONSE_SCHEMA: JsonSchemaSpec = {
  name: 'finance_answer',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'action',
      'queries',
      'headline',
      'sections',
      'seriesTitle',
      'seriesUnit',
      'series',
      'note',
    ],
    properties: {
      action: {
        type: 'string',
        enum: ['answer', 'query'],
        description: '"query" — нужны сырые операции, "answer" — готов ответить',
      },
      queries: {
        type: 'array',
        description: 'Только при action="query": какие операции показать. Иначе пустой массив',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'from',
            'to',
            'type',
            'category',
            'subcategory',
            'account',
            'search',
            'minUsd',
            'limit',
          ],
          properties: {
            from: { type: 'string', description: 'Дата с, YYYY-MM-DD, или пустая строка' },
            to: { type: 'string', description: 'Дата по, YYYY-MM-DD, или пустая строка' },
            type: { type: 'string', description: 'Расход, Доход, Перевод или пустая строка' },
            category: { type: 'string', description: 'Точное имя категории или пустая строка' },
            subcategory: { type: 'string', description: 'Точное имя подкатегории или пустая' },
            account: { type: 'string', description: 'ID счёта или пустая строка' },
            search: { type: 'string', description: 'Подстрока в комментарии или пустая строка' },
            minUsd: { type: 'number', description: 'Минимальная сумма в USD, 0 без ограничения' },
            limit: { type: 'number', description: 'Сколько строк вернуть, до 50' },
          },
        },
      },
      headline: { type: 'string', description: 'Один короткий вывод с главной цифрой' },
      sections: {
        type: 'array',
        description: 'Блоки ответа: разбор, прогноз, рекомендация',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'bullets'],
          properties: {
            title: { type: 'string', description: 'Заголовок блока, можно пустой' },
            bullets: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      seriesTitle: { type: 'string', description: 'Заголовок графика или пустая строка' },
      seriesUnit: { type: 'string', description: '"$", "%" или код валюты' },
      series: {
        type: 'array',
        description: 'Точки для столбчатой диаграммы динамики, по порядку. Пусто — без графика',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'value'],
          properties: {
            label: { type: 'string', description: 'Короткая подпись, например «июн 26»' },
            value: { type: 'number' },
          },
        },
      },
      note: { type: 'string', description: 'Допущения и оговорки или пустая строка' },
    },
  },
};

function aliasBlock(aliases: Alias[]): string {
  if (aliases.length === 0) return '';
  const lines = aliases.map((a) => `- «${a.phrase}» → ${a.meaning}`).join('\n');
  return `\nЛичные слова и правила владельца (фраза → что она значит):\n${lines}\n`;
}

const RULES = `Ты финансовый аналитик владельца этой таблицы учёта. Отвечаешь по-русски, коротко и по делу.

Главное правило: ВСЕ числа уже посчитаны за тебя в блоке данных ниже. Бери их оттуда.
Никогда не складывай длинные списки операций в уме и не выдумывай цифры, которых в данных нет.
Если для ответа нужны отдельные операции, а не агрегаты, — верни action="query" с фильтрами,
тебе пришлют строки, и на следующем шаге ответишь. Не запрашивай то, что уже есть в агрегатах.

Как отвечать (action="answer"):
- headline — один вывод с главной цифрой, без воды.
- sections — 1-3 блока: разбор, прогноз/план, что делать. В bullets — короткие фразы.
- series — динамика по месяцам, если вопрос про неё: label «июн 26», value в seriesUnit, по порядку.
- note — допущения: что в оценку не вошло, где мало данных.
- Пиши обычным текстом. НЕ используй markdown, HTML, звёздочки и решётки — оформит бот.
- Суммы — в USD, если владелец не спросил про конкретную валюту.

Что значат данные:
- «Разовые» траты помечены владельцем как крупные нетипичные и исключены из регулярных — не смешивай их с обычным месяцем.
- Переводы — движение между своими счетами, это НЕ траты. Но по ним видно платежи по кредитам и пополнение накоплений.
- Текущий месяц неполный: сравнивая его с прошлыми, учитывай, сколько дней прошло.
- Планируя, опирайся на медиану, а не на среднее: один дорогой месяц не должен задирать план.`;

export interface AnalystTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnalystInput {
  question: string;
  ref: Reference;
  txns: Txn[];
  aliases?: Alias[];
  history?: AnalystTurn[];
}

export interface Analyst {
  ask(input: AnalystInput): Promise<Answer>;
}

function describeQuery(query: Partial<TxnQuery>): string {
  const parts = Object.entries(query)
    .filter(([, value]) => value !== '' && value !== 0)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(', ') || 'без фильтров';
}

export function runQueries(txns: Txn[], queries: Partial<TxnQuery>[]): string {
  const blocks = queries.slice(0, MAX_QUERIES_PER_ROUND).map((query, i) => {
    const found = findTxns(txns, query);
    const header = `Запрос ${i + 1} (${describeQuery(query)}) — строк: ${found.length}`;
    if (found.length === 0) return `${header}. Ничего не найдено.`;
    return [
      `${header}:`,
      'дата;тип;счёт;категория;подкатегория;USD;разовая;комментарий',
      ...found.map((t) =>
        [
          t.date,
          t.type,
          t.account,
          t.category,
          t.subcategory,
          Math.round(t.usd),
          t.oneOff ? 'да' : '',
          t.comment,
        ].join(';'),
      ),
    ].join('\n');
  });

  return blocks.join('\n\n');
}

export function createAnalyst(options: OpenRouterOptions & { timeZone: string }): Analyst {
  return {
    async ask({ question, ref, txns, aliases = [], history = [] }) {
      const today = todayIn(options.timeZone);
      const system = `${RULES}\n${aliasBlock(aliases)}\n=== ДАННЫЕ ===\n${buildDigest(ref, txns, today)}`;

      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...history.map((turn) => ({ role: turn.role, content: turn.content }) as ChatMessage),
        { role: 'user', content: question },
      ];

      let raw = analystResponseSchema.parse(await completeJson(options, messages, RESPONSE_SCHEMA));

      for (let round = 1; round < MAX_ROUNDS; round++) {
        if (raw.action !== 'query' || raw.queries.length === 0) break;

        logger.info({ round, queries: raw.queries.length }, 'Analyst requested raw operations');
        messages.push(
          { role: 'assistant', content: JSON.stringify({ action: 'query', queries: raw.queries }) },
          {
            role: 'user',
            content:
              `${runQueries(txns, raw.queries)}\n\n` +
              (round + 1 < MAX_ROUNDS
                ? 'Ответь на вопрос по этим строкам или запроси ещё.'
                : 'Это последние данные — теперь ответь, action="answer".'),
          },
        );
        raw = analystResponseSchema.parse(await completeJson(options, messages, RESPONSE_SCHEMA));
      }

      return toAnswer(raw);
    },
  };
}

import { z } from 'zod/v4';
import { buildDigest } from '../analytics/digest.js';
import {
  buildReviewSignals,
  reviewSignalsBlock,
  type ReviewSignals,
} from '../analytics/signals.js';
import type { Txn } from '../analytics/dataset.js';
import { findTxns, type TxnQuery } from '../analytics/queries.js';
import type { Answer, AnswerSection } from '../domain/answer.js';
import type { Review } from '../domain/review.js';
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
const MAX_INSIGHTS = 4;
const MAX_ACTIONS = 3;

/** Thinking budgets. A review is the whole point of thinking; a question needs less of it. */
const ASK_REASONING_TOKENS = 3_000;
const REVIEW_REASONING_TOKENS = 8_000;

/**
 * Reasoning is switched on only where it was verified end to end through the owner's ZDR
 * routing (Claude on Vertex honours `reasoning.max_tokens`). Other models keep answering
 * without a budget rather than gamble on a parameter their endpoint may mishandle.
 */
function withReasoning(options: OpenRouterOptions, tokens: number): OpenRouterOptions {
  return options.model.startsWith('anthropic/') ? { ...options, reasoningTokens: tokens } : options;
}

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

/**
 * Models sometimes put a heading and its bullets into two sections: a titled one with no
 * bullets, then an untitled one. Rendered as is, that is an empty heading over orphan text.
 */
function mergeSections(sections: { title: string; bullets: string[] }[]): AnswerSection[] {
  const merged: AnswerSection[] = [];
  for (const section of sections) {
    const title = section.title.trim();
    const bullets = section.bullets.map((bullet) => bullet.trim()).filter(Boolean);
    const previous = merged.at(-1);

    if (!title && previous && previous.bullets.length === 0) {
      previous.bullets.push(...bullets);
      continue;
    }
    if (!title && bullets.length === 0) continue;
    merged.push({ title, bullets });
  }

  return merged
    .slice(0, MAX_SECTIONS)
    .map((section) => ({ title: section.title, bullets: section.bullets.slice(0, MAX_BULLETS) }));
}

export function toAnswer(raw: AnalystResponse): Answer {
  return {
    headline: raw.headline.trim(),
    sections: mergeSections(raw.sections),
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

/** How the owner wants to be spoken to — shared by answers and reviews. */
const VOICE = `Владелец не экономист и не финансист — обычный человек, термины знает поверхностно. Говори на его уровне:
- простыми словами, как друг, который разбирается в деньгах, на «ты»: «обычно тратишь», а не «медиана»; «отложил», а не «норма сбережений»;
- если без термина не обойтись — поясни его одной фразой прямо в тексте;
- не используй слова «медиана», «паттерн», «дельта», «тренд», «волатильность», «перцентиль», «норма сбережений» — скажи то же обычными словами: «обычно», «привычка», «разница», «растёт», «скачет», «сколько отложил»;
- не объясняй цифры догадками, которых нет в данных: если причина неизвестна — так и скажи;
- не просто называй цифру, а объясняй, что за ней стоит и почему так вышло: какая категория дала разницу, стал покупать чаще или дороже, всплеск это или уже привычка;
- если видишь что-то неочевидное и полезное — скажи, даже если прямо не спрашивали;
- не морализируй и не пугай: рост трат не преступление, важно, осознанный ли он.`;

const RULES = `Ты личный финансовый аналитик владельца этой таблицы учёта. Отвечаешь по-русски.

${VOICE}

Главное правило: ВСЕ числа уже посчитаны за тебя в блоке данных ниже. Бери их оттуда.
Никогда не складывай длинные списки операций в уме и не выдумывай цифры, которых в данных нет.
Если для ответа нужны отдельные операции, а не агрегаты, — верни action="query" с фильтрами,
тебе пришлют строки, и на следующем шаге ответишь. Не запрашивай то, что уже есть в агрегатах.
Блоки СИГНАЛЫ показывают, что в этом месяце и на прошлой неделе отличается от обычного: суммы, число покупок,
средний чек, сколько периодов подряд категория выше обычного, самые крупные траты. Опирайся на них, объясняя «почему».

Как отвечать (action="answer"):
- headline — один вывод с главной цифрой, без воды.
- sections — 1-3 блока: разбор, прогноз/план, что делать. В bullets — законченные мысли с цифрами, 1–2 предложения, а не обрывки.
- series — динамика, если вопрос про неё: label «июн 26» для месяцев или «08–14.09» для недель, value в seriesUnit, по порядку.
- note — допущения: что в оценку не вошло, где мало данных.
- Пиши обычным текстом. НЕ используй markdown, HTML, звёздочки и решётки — оформит бот.
- Суммы — в USD, если владелец не спросил про конкретную валюту.

Что значат данные:
- «Разовые» траты помечены владельцем как крупные нетипичные и исключены из регулярных — не смешивай их с обычным месяцем.
- Переводы — движение между своими счетами, это НЕ траты. Но по ним видно платежи по кредитам и пополнение накоплений.
- Текущий месяц неполный: сравнивая его с прошлыми, учитывай, сколько дней прошло. Так же и с текущей неделей.
- Есть готовый разрез по неделям (ISO, понедельник–воскресенье) — на вопросы «сколько за неделю» отвечай из него, не запрашивая строки.
- Планируя, опирайся на «обычно», а не на среднее арифметическое: один дорогой месяц не должен задирать план.`;

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

export interface ReviewInput {
  signals: ReviewSignals;
  ref: Reference;
  txns: Txn[];
  aliases?: Alias[];
}

export interface Analyst {
  ask(input: AnalystInput): Promise<Answer>;
  /** A plain-language analysis of one period, built on precomputed signals. */
  review(input: ReviewInput): Promise<Review>;
}

export const reviewResponseSchema = z.object({
  headline: z.string().catch(''),
  story: z.string().catch(''),
  insights: z
    .array(
      z.object({
        tone: z.enum(['good', 'watch', 'alert', 'info']).catch('info'),
        title: z.string().catch(''),
        text: z.string().catch(''),
      }),
    )
    .catch([]),
  actions: z
    .array(
      z.object({
        action: z.string().catch(''),
        why: z.string().catch(''),
        effect: z.string().catch(''),
      }),
    )
    .catch([]),
  explain: z.string().catch(''),
  followUp: z.string().catch(''),
});

export function toReview(raw: z.infer<typeof reviewResponseSchema>): Review {
  return {
    headline: raw.headline.trim(),
    story: raw.story.trim(),
    insights: raw.insights
      .map((i) => ({ tone: i.tone, title: i.title.trim(), text: i.text.trim() }))
      .filter((i) => i.text)
      .slice(0, MAX_INSIGHTS),
    actions: raw.actions
      .map((a) => ({ action: a.action.trim(), why: a.why.trim(), effect: a.effect.trim() }))
      .filter((a) => a.action)
      .slice(0, MAX_ACTIONS),
    explain: raw.explain.trim(),
    followUp: raw.followUp.trim(),
  };
}

const REVIEW_SCHEMA: JsonSchemaSpec = {
  name: 'finance_review',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'story', 'insights', 'actions', 'explain', 'followUp'],
    properties: {
      headline: { type: 'string', description: 'Главный вывод одной простой фразой, с цифрой' },
      story: {
        type: 'string',
        description: '2–4 предложения связным текстом: что произошло с деньгами и почему',
      },
      insights: {
        type: 'array',
        description: '2–4 наблюдения, самые полезные первыми',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['tone', 'title', 'text'],
          properties: {
            tone: {
              type: 'string',
              enum: ['good', 'watch', 'alert', 'info'],
              description:
                'good — хорошо, watch — стоит присмотреться, alert — сильно выбивается, info — просто факт',
            },
            title: { type: 'string', description: '2–5 слов' },
            text: { type: 'string', description: '1–2 предложения с конкретными цифрами' },
          },
        },
      },
      actions: {
        type: 'array',
        description: '0–3 конкретных шага, только если есть что менять',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'why', 'effect'],
          properties: {
            action: { type: 'string', description: 'Что сделать, конкретно' },
            why: { type: 'string', description: 'Почему это поможет' },
            effect: { type: 'string', description: 'Ожидаемый эффект в $ или пустая строка' },
          },
        },
      },
      explain: {
        type: 'string',
        description:
          'Одно понятие простыми словами, если помогает понять разбор, иначе пустая строка',
      },
      followUp: {
        type: 'string',
        description: 'Один вопрос, который владельцу стоит задать дальше, или пустая строка',
      },
    },
  },
};

const REVIEW_RULES = `Ты личный финансовый аналитик владельца. Отвечаешь по-русски.
Твоя задача — не пересказать цифры, а объяснить, что происходит с его деньгами, почему, и что с этим можно сделать.

${VOICE}

Что искать — это и есть инсайты:
- Главная причина отклонения: какие 1–2 категории дали разницу и что это значит в жизни.
- «Чаще» или «дороже»: сравни число покупок и средний чек с обычными. Это разные истории.
- Привычка или всплеск: категория выше обычного несколько периодов подряд — привычка; один раз — всплеск.
- Компенсации: где-то больше, где-то меньше — общий итог может скрывать перекос.
- Крупные траты: по комментарию владельца объясни, что это было и насколько оно выбивается.
- Новые траты, которых раньше не было.
- Хорошее — тоже инсайт: где тратишь меньше обычного, сколько отложил.
- Для месяца, который ещё идёт, — куда он придёт при обычном темпе.

Строго:
- Бери цифры только из блоков СИГНАЛЫ и ОБЩАЯ КАРТИНА. Ничего не пересчитывай и не выдумывай. Суммы округляй и пиши в $.
- Если данных мало (мало покупок, нет обычного уровня для сравнения) — честно скажи это в story, а не додумывай.
- actions — только конкретика с цифрами («ограничить рестораны до $80 в неделю»), никаких «следите за расходами». Нечего менять — оставь пустым.
- Пиши обычным текстом: без markdown, HTML, звёздочек и решёток — оформит бот.`;

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
      const askOptions = withReasoning(options, ASK_REASONING_TOKENS);
      const system = [
        RULES,
        aliasBlock(aliases),
        '=== ДАННЫЕ ===',
        buildDigest(ref, txns, today),
        '=== СИГНАЛЫ: ЭТОТ МЕСЯЦ ПОКА ===',
        reviewSignalsBlock(buildReviewSignals(txns, ref, today, 'mtd')),
        '=== СИГНАЛЫ: ПРОШЛАЯ НЕДЕЛЯ ===',
        reviewSignalsBlock(buildReviewSignals(txns, ref, today, 'week')),
      ].join('\n');

      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...history.map((turn) => ({ role: turn.role, content: turn.content }) as ChatMessage),
        { role: 'user', content: question },
      ];

      let raw = analystResponseSchema.parse(
        await completeJson(askOptions, messages, RESPONSE_SCHEMA),
      );

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
        raw = analystResponseSchema.parse(
          await completeJson(askOptions, messages, RESPONSE_SCHEMA),
        );
      }

      return toAnswer(raw);
    },

    async review({ signals, ref, txns, aliases = [] }) {
      const today = todayIn(options.timeZone);
      const system = [
        REVIEW_RULES,
        aliasBlock(aliases),
        '=== СИГНАЛЫ ===',
        reviewSignalsBlock(signals),
        '=== ОБЩАЯ КАРТИНА (счета, бюджет, история по месяцам и неделям) ===',
        buildDigest(ref, txns, today),
      ].join('\n');

      const raw = await completeJson(
        withReasoning(options, REVIEW_REASONING_TOKENS),
        [
          { role: 'system', content: system },
          { role: 'user', content: `Сделай разбор: ${signals.window.title}.` },
        ],
        REVIEW_SCHEMA,
      );
      return toReview(reviewResponseSchema.parse(raw));
    },
  };
}

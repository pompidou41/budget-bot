import type { Bot, Context } from 'grammy';
import type { AnalystTurn } from '../../ai/analyst.js';
import { renderAnswer, renderAnswerRich } from '../../domain/answer.js';
import { escapeHtml } from '../../domain/format.js';
import { logger } from '../../logger.js';
import type { AppDeps } from '../deps.js';
import { editView } from '../rich.js';
import { describeError, inBackground } from '../telegram.js';
import { transcribeVoice, transcriptLine } from '../voice.js';

/** Messages kept in a conversation: five question/answer pairs. */
const MAX_TURNS = 10;
const MAX_QUESTION_LENGTH = 1000;

const HINT = [
  '🧠 <b>Спроси про свои финансы</b>',
  '',
  'Напиши вопрос после команды:',
  '• <code>/ask сколько я потратил на еду за 3 месяца, покажи динамику</code>',
  '• <code>/ask сколько откладывать на регулярные траты</code>',
  '• <code>/ask какой остаточный бюджет до конца месяца</code>',
  '• <code>/ask сколько выделять на рестораны, чтобы уложиться</code>',
  '',
  '<i>Ответом (reply) на мой ответ можно продолжить разговор.</i>',
].join('\n');

/** Sends a finance question to the analyst and anchors the thread on the answer message. */
export async function answerQuestion(
  ctx: Context,
  deps: AppDeps,
  question: string,
  history: AnalystTurn[],
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const placeholder = await ctx.reply('⏳ Считаю…', {
    reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id } : undefined,
  });

  try {
    const [ref, txns] = await Promise.all([deps.refs.get(), deps.data.get()]);
    if (txns.length === 0) {
      await ctx.api.editMessageText(
        chatId,
        placeholder.message_id,
        'В листе «Операции» пока нет данных для анализа.',
      );
      return;
    }

    const result = await deps.analyst.ask({
      question,
      ref,
      txns,
      aliases: deps.settings.get().aliases,
      history,
    });

    await editView(
      ctx.api,
      chatId,
      placeholder.message_id,
      { rich: renderAnswerRich(result), html: renderAnswer(result) },
      deps.env.RENDER_MODE,
    );

    const turns: AnalystTurn[] = [
      ...history,
      { role: 'user', content: question },
      { role: 'assistant', content: JSON.stringify({ action: 'answer', ...result }) },
    ];
    // The fresh answer becomes the anchor: a reply to it continues this thread
    deps.conversations.remember(chatId, placeholder.message_id, turns.slice(-MAX_TURNS));
  } catch (error) {
    logger.error({ error }, 'Failed to answer a finance question');
    await ctx.api.editMessageText(
      chatId,
      placeholder.message_id,
      `⚠️ Не получилось посчитать: ${escapeHtml(describeError(error))}`,
      { parse_mode: 'HTML' },
    );
  }
}

export function registerAsk(bot: Bot, deps: AppDeps): void {
  /**
   * History behind a reply, or undefined when the reply is not aimed at an answer of mine.
   * A known anchor whose history has expired yields an empty thread rather than nothing:
   * the question is still a question, and must not fall through to the operation parser.
   */
  function threadFor(ctx: Context): AnalystTurn[] | undefined {
    const chatId = ctx.chat?.id;
    const replyTo = ctx.msg?.reply_to_message?.message_id;
    if (chatId === undefined || replyTo === undefined) return undefined;
    if (!deps.conversations.knows(chatId, replyTo)) return undefined;
    return deps.conversations.recall(chatId, replyTo) ?? [];
  }

  bot.command('ask', async (ctx) => {
    const question = ctx.match.trim();
    if (!question) {
      await ctx.reply(HINT, { parse_mode: 'HTML' });
      return;
    }
    await ctx.replyWithChatAction('typing');
    inBackground(answerQuestion(ctx, deps, question.slice(0, MAX_QUESTION_LENGTH), []), 'ask');
  });

  // Runs before the catch-all input handlers: only claims replies to an answer of mine
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    const history = threadFor(ctx);

    if (!history || !text || text.startsWith('/')) {
      await next();
      return;
    }

    await ctx.replyWithChatAction('typing');
    inBackground(answerQuestion(ctx, deps, text.slice(0, MAX_QUESTION_LENGTH), history), 'ask');
  });

  // A spoken follow-up is still a follow-up; without this it reached the operation parser
  bot.on('message:voice', async (ctx, next) => {
    const history = threadFor(ctx);
    if (!history) {
      await next();
      return;
    }

    const transcript = await transcribeVoice(ctx, deps);
    if (transcript === null) return;

    await ctx.reply(transcriptLine(transcript), { parse_mode: 'HTML' });
    inBackground(
      answerQuestion(ctx, deps, transcript.slice(0, MAX_QUESTION_LENGTH), history),
      'ask',
    );
  });

  // Offered when a message parsed into no operations: it was probably a question
  bot.callbackQuery('a:q', async (ctx) => {
    const question = ctx.callbackQuery.message?.reply_to_message?.text?.trim();
    await ctx.answerCallbackQuery();
    if (!question) return;

    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.replyWithChatAction('typing');
    inBackground(answerQuestion(ctx, deps, question.slice(0, MAX_QUESTION_LENGTH), []), 'ask');
  });
}

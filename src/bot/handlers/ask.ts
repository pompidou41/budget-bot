import type { Bot, Context } from 'grammy';
import type { AnalystTurn } from '../../ai/analyst.js';
import { renderAnswer } from '../../domain/answer.js';
import { escapeHtml } from '../../domain/format.js';
import { logger } from '../../logger.js';
import type { AppDeps } from '../deps.js';
import { describeError, editHtml } from '../telegram.js';

const HISTORY_TTL_MS = 30 * 60 * 1000;
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

/** One `/ask` thread, anchored to the bot message that holds the last answer. */
interface Conversation {
  turns: AnalystTurn[];
  touchedAt: number;
}

export function registerAsk(bot: Bot, deps: AppDeps): void {
  const conversations = new Map<string, Conversation>();

  function key(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  function sweep(): void {
    const now = Date.now();
    for (const [id, conversation] of conversations) {
      if (now - conversation.touchedAt > HISTORY_TTL_MS) conversations.delete(id);
    }
  }

  function recall(chatId: number, messageId: number): Conversation | undefined {
    sweep();
    return conversations.get(key(chatId, messageId));
  }

  async function answer(ctx: Context, question: string, history: AnalystTurn[]): Promise<void> {
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

      await editHtml(ctx.api, chatId, placeholder.message_id, renderAnswer(result));

      const turns: AnalystTurn[] = [
        ...history,
        { role: 'user', content: question },
        { role: 'assistant', content: JSON.stringify({ action: 'answer', ...result }) },
      ];
      // The fresh answer becomes the anchor: a reply to it continues this thread
      conversations.set(key(chatId, placeholder.message_id), {
        turns: turns.slice(-MAX_TURNS),
        touchedAt: Date.now(),
      });
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

  bot.command('ask', async (ctx) => {
    const question = ctx.match.trim();
    if (!question) {
      await ctx.reply(HINT, { parse_mode: 'HTML' });
      return;
    }
    await ctx.replyWithChatAction('typing');
    await answer(ctx, question.slice(0, MAX_QUESTION_LENGTH), []);
  });

  // Runs before the catch-all input handlers: only claims replies to an answer of mine
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    const text = ctx.message.text.trim();
    const conversation = replyTo === undefined ? undefined : recall(ctx.chat.id, replyTo);

    if (!conversation || !text || text.startsWith('/')) {
      await next();
      return;
    }

    await ctx.replyWithChatAction('typing');
    await answer(ctx, text.slice(0, MAX_QUESTION_LENGTH), conversation.turns);
  });
}

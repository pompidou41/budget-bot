import type { Bot } from 'grammy';
import { renderBalance, renderBalanceRich } from '../../domain/balance.js';
import { renderCard } from '../../domain/card.js';
import { todayIn } from '../../domain/dates.js';
import { blankOperation } from '../../domain/operation.js';
import { activeAccounts } from '../../domain/reference.js';
import type { AppDeps } from '../deps.js';
import { undoConfirmKeyboard } from '../keyboards.js';
import { sendView } from '../rich.js';
import { renderDraft } from '../render.js';

export const BOT_COMMANDS = [
  { command: 'add', description: 'Добавить операцию кнопками' },
  { command: 'undo', description: 'Отменить последнюю запись' },
  { command: 'balance', description: 'Остатки по счетам' },
  { command: 'review', description: 'Разбор финансов: что происходит и почему' },
  { command: 'report', description: 'Траты по категориям и периодам' },
  { command: 'ask', description: 'Спросить про свои финансы' },
  { command: 'refresh', description: 'Перечитать счета и категории' },
  { command: 'settings', description: 'Настройки: счёт по умолчанию, алиасы' },
  { command: 'help', description: 'Справка' },
];

const HELP_TEXT = [
  '<b>Как вносить операции</b>',
  'Напиши или надиктуй, что произошло, — я разберу и покажу черновик:',
  '• <code>кофе 300 с тинька</code>',
  '• <code>такси 500 с альфы и продукты 2300 налом</code>',
  '• <code>вчера зп 150000 на газпром</code>',
  '• <code>обменял 10000 руб с тинька на 110 usdt на байбит</code>',
  'Можно прислать фото чека или скриншот.',
  '',
  'Черновик правится кнопками или ответом (reply) на него: «это было вчера», «сумма 450».',
  'Если счёт не назван — спрошу.',
  '',
  '/add — пошагово кнопками',
  '/undo — отменить последнюю запись бота',
  '/balance — остатки по счетам',
  '/review — разбор от ИИ: что происходит с деньгами, почему и что с этим делать',
  '   <code>/review</code> · <code>/review месяц</code> · <code>/review этот месяц</code>',
  '/report — траты по категориям: недели, месяцы, выбор категорий',
  '/ask — вопрос про финансы: анализ, прогноз, планирование',
  '   <code>/ask сколько я потратил на еду за 3 месяца</code>',
  '   <i>ответом (reply) на ответ можно продолжить разговор</i>',
  '/refresh — перечитать счета и категории из таблицы',
  '/settings — счёт по умолчанию и мои алиасы',
].join('\n');

function formatSavedAt(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function registerCommands(bot: Bot, deps: AppDeps): void {
  const timeZone = deps.env.BOT_TIMEZONE;

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('add', async (ctx) => {
    const ref = await deps.refs.get();
    const draft = deps.drafts.create(ctx.chat.id, blankOperation(todayIn(timeZone)), {
      wizard: true,
      view: { kind: 'pick', picker: 'date' },
    });
    const { text, keyboard } = renderDraft(draft, ref);
    const message = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    draft.messageId = message.message_id;
  });

  bot.command('undo', async (ctx) => {
    const entry = deps.journal.last();
    if (!entry) {
      await ctx.reply('Нечего отменять — бот пока ничего не записывал.');
      return;
    }
    const ref = await deps.refs.get();
    await ctx.reply(
      renderCard(entry.op, ref, {
        footer: `🗑 Удалить строку ${entry.row} (записана ${formatSavedAt(entry.savedAt, timeZone)})?`,
      }),
      { parse_mode: 'HTML', reply_markup: undoConfirmKeyboard(entry.row) },
    );
  });

  bot.command('balance', async (ctx) => {
    const ref = await deps.refs.reload();
    await sendView(
      ctx.api,
      ctx.chat.id,
      { rich: renderBalanceRich(ref), html: renderBalance(ref) },
      deps.env.RENDER_MODE,
    );
  });

  bot.command('refresh', async (ctx) => {
    const [ref, txns] = await Promise.all([deps.refs.reload(), deps.data.reload()]);
    deps.health.headerProblems = await deps.checkHeader();
    const header =
      deps.health.headerProblems.length === 0
        ? '✅ Шапка «Операции» в порядке.'
        : `⚠️ Запись отключена, шапка «Операции» не совпадает:\n${deps.health.headerProblems.join('\n')}`;
    await ctx.reply(
      `🔄 Счетов: ${activeAccounts(ref).length}, категорий: ${ref.categories.length}, ` +
        `операций в истории: ${txns.length}.\n${header}`,
    );
  });

  bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
    const row = Number((ctx.match as RegExpMatchArray)[1]);
    const entry = deps.journal.find(row);
    if (!entry) {
      await ctx.answerCallbackQuery({
        text: 'Эта запись уже отменена или слишком старая.',
        show_alert: true,
      });
      return;
    }

    const result = await deps.repo.undo(row, entry.values);
    if (result === 'changed') {
      await ctx.answerCallbackQuery({
        text: `Строка ${row} изменена вручную — удали её в таблице.`,
        show_alert: true,
      });
      return;
    }
    deps.journal.remove(row);

    // The undone operation comes back as an editable draft in the same message
    const ref = await deps.refs.get();
    const draft = deps.drafts.create(ctx.chat?.id ?? ctx.from.id, entry.op, {
      messageId: ctx.callbackQuery.message?.message_id,
    });
    const footer =
      result === 'cleared'
        ? `↩️ Строка ${row} удалена. Можно поправить и сохранить заново.`
        : `↩️ Строка ${row} уже была пустой.`;
    const { text, keyboard } = renderDraft(draft, ref, footer);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.answerCallbackQuery('Отменено');
  });

  bot.callbackQuery('u:keep', async (ctx) => {
    await ctx.editMessageReplyMarkup();
    await ctx.answerCallbackQuery('Оставил как есть');
  });
}

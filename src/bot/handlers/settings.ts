import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { escapeHtml } from '../../domain/format.js';
import { activeAccounts, findAccount, type Reference } from '../../domain/reference.js';
import {
  MAX_ALIASES,
  MAX_MEANING_LENGTH,
  MAX_PHRASE_LENGTH,
  parseAliasInput,
  type Settings,
} from '../../domain/settings.js';
import type { AppDeps } from '../deps.js';
import { grid } from '../keyboards.js';
import { ignoreNotModified } from '../telegram.js';

const ALIAS_INPUT_TTL_MS = 15 * 60 * 1000;
const ALIAS_BUTTON_LENGTH = 24;

type View = 'home' | 'acc' | 'al' | 'add';

/** Settings message waiting for the text of a new alias. */
interface Pending {
  messageId: number;
  since: number;
}

const FORMAT_HINT = [
  'Напиши одним сообщением: <code>фраза = значение</code>',
  '',
  'Примеры:',
  '• <code>НЗ = T_SAVE</code>',
  '• <code>перевод на озон банк самому себе = категория Покупки</code>',
].join('\n');

function accountLine(settings: Settings, ref: Reference): string {
  if (!settings.defaultAccount) return '🏦 Счёт по умолчанию: <b>не задан</b> — буду спрашивать.';
  const account = findAccount(ref, settings.defaultAccount);
  const name = account ? ` <i>(${escapeHtml(account.name)})</i>` : ' <i>(нет в «Счетах»)</i>';
  return `🏦 Счёт по умолчанию: <b>${escapeHtml(settings.defaultAccount)}</b>${name}`;
}

function homeView(settings: Settings, ref: Reference): { text: string; keyboard: InlineKeyboard } {
  const text = [
    '⚙️ <b>Настройки</b>',
    '',
    accountLine(settings, ref),
    '<i>Подставляю его в расход, если счёт не назван.</i>',
    '',
    `🏷 Алиасы: <b>${settings.aliases.length}</b>`,
    '<i>Мои слова и правила: что значит «НЗ», как считать переводы.</i>',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('🏦 Счёт по умолчанию', 's:acc')
    .row()
    .text(`🏷 Алиасы (${settings.aliases.length})`, 's:al')
    .row()
    .text('✖️ Закрыть', 's:close');

  return { text, keyboard };
}

function accountsView(
  settings: Settings,
  ref: Reference,
): { text: string; keyboard: InlineKeyboard } {
  const keyboard = grid(
    activeAccounts(ref).map((a, i) => ({
      label: `${a.id === settings.defaultAccount ? '✅ ' : ''}${a.id} · ${a.currency}`,
      data: `s:acc:${i}`,
    })),
    2,
  )
    .text('🚫 Не подставлять', 's:acc:none')
    .row()
    .text('← Назад', 's:home');

  return {
    text: [
      '🏦 <b>Счёт по умолчанию</b>',
      '',
      'Подставлю его в расход, когда в сообщении счёт не назван.',
      'Доходы и переводы всегда спрашиваю.',
      '',
      accountLine(settings, ref),
    ].join('\n'),
    keyboard,
  };
}

function aliasesView(settings: Settings): { text: string; keyboard: InlineKeyboard } {
  const lines = settings.aliases.map(
    (a, i) => `${i + 1}. <b>${escapeHtml(a.phrase)}</b> → ${escapeHtml(a.meaning)}`,
  );
  const text = [
    '🏷 <b>Алиасы</b>',
    '',
    'Учитываю их при разборе текста, голосовых и скриншотов.',
    '',
    ...(lines.length > 0 ? lines : ['<i>Пока пусто.</i>']),
  ].join('\n');

  const keyboard = new InlineKeyboard();
  for (const alias of settings.aliases) {
    const label =
      alias.phrase.length > ALIAS_BUTTON_LENGTH
        ? `${alias.phrase.slice(0, ALIAS_BUTTON_LENGTH - 1)}…`
        : alias.phrase;
    keyboard.text(`🗑 ${label}`, `s:al:del:${alias.id}`).row();
  }
  if (settings.aliases.length < MAX_ALIASES) keyboard.text('➕ Добавить', 's:al:add').row();

  return { text, keyboard: keyboard.text('← Назад', 's:home') };
}

function addAliasView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      '➕ <b>Новый алиас</b>',
      '',
      FORMAT_HINT,
      '',
      `<i>Фраза до ${MAX_PHRASE_LENGTH} символов, значение до ${MAX_MEANING_LENGTH}.</i>`,
    ].join('\n'),
    keyboard: new InlineKeyboard().text('← Назад', 's:al'),
  };
}

function render(
  view: View,
  settings: Settings,
  ref: Reference,
): { text: string; keyboard: InlineKeyboard } {
  switch (view) {
    case 'home':
      return homeView(settings, ref);
    case 'acc':
      return accountsView(settings, ref);
    case 'al':
      return aliasesView(settings);
    case 'add':
      return addAliasView();
  }
}

export function registerSettings(bot: Bot, deps: AppDeps): void {
  // One settings message per chat may wait for typed alias text
  const pending = new Map<number, Pending>();

  function awaiting(chatId: number): Pending | undefined {
    const entry = pending.get(chatId);
    if (!entry) return undefined;
    if (Date.now() - entry.since > ALIAS_INPUT_TTL_MS) {
      pending.delete(chatId);
      return undefined;
    }
    return entry;
  }

  async function show(ctx: Context, view: View, notice?: string): Promise<void> {
    const ref = await deps.refs.get();
    const { text, keyboard } = render(view, deps.settings.get(), ref);
    await ignoreNotModified(
      ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }),
    );
    await ctx.answerCallbackQuery(notice ?? undefined);
  }

  bot.command('settings', async (ctx) => {
    pending.delete(ctx.chat.id);
    const ref = await deps.refs.get();
    const { text, keyboard } = homeView(deps.settings.get(), ref);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.callbackQuery(/^s:(\w+)(?::(\w+))?(?::([0-9a-f]+))?$/, async (ctx) => {
    const [, section = '', action, arg] = ctx.match as RegExpMatchArray;
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) pending.delete(chatId);

    switch (section) {
      case 'close':
        // Keep the message as a record of the settings, drop the buttons
        await ignoreNotModified(ctx.editMessageReplyMarkup());
        await ctx.answerCallbackQuery('Закрыл');
        return;

      case 'home':
        await show(ctx, 'home');
        return;

      case 'acc': {
        if (action === undefined) {
          await show(ctx, 'acc');
          return;
        }
        if (action === 'none') {
          deps.settings.setDefaultAccount(null);
          await show(ctx, 'acc', 'Не буду подставлять счёт');
          return;
        }
        const ref = await deps.refs.get();
        const account = activeAccounts(ref)[Number(action)];
        if (!account) {
          await show(ctx, 'acc', 'Список счетов обновился — выбери ещё раз');
          return;
        }
        deps.settings.setDefaultAccount(account.id);
        await show(ctx, 'acc', `Счёт по умолчанию: ${account.id}`);
        return;
      }

      case 'al': {
        if (action === 'add') {
          if (chatId !== undefined && ctx.callbackQuery.message) {
            pending.set(chatId, {
              messageId: ctx.callbackQuery.message.message_id,
              since: Date.now(),
            });
          }
          await show(ctx, 'add');
          return;
        }
        if (action === 'del' && arg !== undefined) {
          const removed = deps.settings.removeAlias(arg);
          await show(ctx, 'al', removed ? 'Удалил' : 'Уже удалён');
          return;
        }
        await show(ctx, 'al');
        return;
      }

      default:
        await ctx.answerCallbackQuery('Неизвестная кнопка');
    }
  });

  // Runs before the catch-all input handlers: only claims text meant for a new alias
  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const entry = awaiting(chatId);
    const text = ctx.message.text.trim();
    const replyTo = ctx.message.reply_to_message?.message_id;

    // A command, or a reply aimed at some other message, is not the alias we asked for
    if (!entry || text.startsWith('/') || (replyTo !== undefined && replyTo !== entry.messageId)) {
      await next();
      return;
    }

    const parsed = parseAliasInput(text);
    if (!parsed) {
      await ctx.reply(`Не понял алиас.\n\n${FORMAT_HINT}`, { parse_mode: 'HTML' });
      return;
    }

    const alias = deps.settings.addAlias(parsed.phrase, parsed.meaning);
    pending.delete(chatId);
    if (!alias) {
      await ctx.reply(`Алиасов уже ${MAX_ALIASES} — удали лишние и добавь заново.`);
      return;
    }

    // The alias is now in the list above; keep the chat tidy
    await ctx.deleteMessage().catch(() => undefined);
    const { text: listText, keyboard } = aliasesView(deps.settings.get());
    await ignoreNotModified(
      ctx.api.editMessageText(chatId, entry.messageId, listText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }),
    );
  });
}

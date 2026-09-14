import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { escapeHtml } from '../../domain/format.js';
import { activeAccounts, findAccount, type Reference } from '../../domain/reference.js';
import {
  MAX_NOTE_LENGTH,
  MAX_NOTES,
  parseNoteInput,
  type Settings,
} from '../../domain/settings.js';
import type { AppDeps } from '../deps.js';
import { grid } from '../keyboards.js';
import { ignoreNotModified } from '../telegram.js';

const NOTE_INPUT_TTL_MS = 15 * 60 * 1000;
const NOTE_BUTTON_LENGTH = 24;
/** Each note in the list is cut to this; the whole note still goes to the AI. */
const NOTE_PREVIEW_LENGTH = 160;
/** The list must fit one Telegram message (4096) together with its heading and buttons. */
const LIST_BUDGET = 3400;

type View = 'home' | 'acc' | 'al' | 'add';

/** Settings message waiting for the text of a new note. */
interface Pending {
  messageId: number;
  since: number;
}

const NOTE_HINT = [
  'Напиши одним сообщением что угодно — бот будет учитывать это, когда разбирает операции и когда отвечает про финансы.',
  '',
  'Например:',
  '• <code>НЗ = T_SAVE</code>',
  '• <code>Елизавета С. — моя девушка Лиза, переводы ей — категория Liza</code>',
  '• <code>Зарплата приходит на Альфу, потом раскладываю: машина, НЗ, постоянные расходы</code>',
  '• <code>Обучение — оплата курсов, это обязательный платёж</code>',
  '• <code>Kazantsev Aa — кофейня у работы</code>',
].join('\n');

function accountLine(settings: Settings, ref: Reference): string {
  if (!settings.defaultAccount) return '🏦 Счёт по умолчанию: <b>не задан</b> — буду спрашивать.';
  const account = findAccount(ref, settings.defaultAccount);
  const name = account ? ` <i>(${escapeHtml(account.name)})</i>` : ' <i>(нет в «Счетах»)</i>';
  return `🏦 Счёт по умолчанию: <b>${escapeHtml(settings.defaultAccount)}</b>${name}`;
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function homeView(settings: Settings, ref: Reference): { text: string; keyboard: InlineKeyboard } {
  const text = [
    '⚙️ <b>Настройки</b>',
    '',
    accountLine(settings, ref),
    '<i>Подставляю его в расход, если счёт не назван.</i>',
    '',
    `📝 Заметки для ИИ: <b>${settings.notes.length}</b>`,
    '<i>Что угодно, что поможет понимать тебя: слова, люди, счета, правила.</i>',
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('🏦 Счёт по умолчанию', 's:acc')
    .row()
    .text(`📝 Заметки для ИИ (${settings.notes.length})`, 's:al')
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

function notesView(settings: Settings): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = [];
  let used = 0;
  for (const [i, note] of settings.notes.entries()) {
    const line = `${i + 1}. ${escapeHtml(clip(note.text, NOTE_PREVIEW_LENGTH))}`;
    if (used + line.length > LIST_BUDGET) {
      lines.push(`<i>…и ещё ${settings.notes.length - i}</i>`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const text = [
    '📝 <b>Заметки для ИИ</b>',
    '',
    'Учитываю их, когда разбираю текст, голосовые и скриншоты, и в /review и /ask.',
    '',
    ...(lines.length > 0 ? lines : ['<i>Пока пусто.</i>']),
  ].join('\n');

  const keyboard = new InlineKeyboard();
  for (const [i, note] of settings.notes.entries()) {
    keyboard
      .text(`🗑 ${i + 1}. ${clip(note.text, NOTE_BUTTON_LENGTH)}`, `s:al:del:${note.id}`)
      .row();
  }
  if (settings.notes.length < MAX_NOTES) keyboard.text('➕ Добавить', 's:al:add').row();

  return { text, keyboard: keyboard.text('← Назад', 's:home') };
}

function addNoteView(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      '➕ <b>Новая заметка</b>',
      '',
      NOTE_HINT,
      '',
      `<i>До ${MAX_NOTE_LENGTH} символов.</i>`,
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
      return notesView(settings);
    case 'add':
      return addNoteView();
  }
}

export function registerSettings(bot: Bot, deps: AppDeps): void {
  // One settings message per chat may wait for typed note text
  const pending = new Map<number, Pending>();

  function awaiting(chatId: number): Pending | undefined {
    const entry = pending.get(chatId);
    if (!entry) return undefined;
    if (Date.now() - entry.since > NOTE_INPUT_TTL_MS) {
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

      // `al` is kept from the alias days, so buttons in old settings messages still work
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
          const removed = deps.settings.removeNote(arg);
          await show(ctx, 'al', removed ? 'Удалил' : 'Уже удалена');
          return;
        }
        await show(ctx, 'al');
        return;
      }

      default:
        await ctx.answerCallbackQuery('Неизвестная кнопка');
    }
  });

  // Runs before the catch-all input handlers: only claims text meant for a new note
  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const entry = awaiting(chatId);
    const text = ctx.message.text;
    const replyTo = ctx.message.reply_to_message?.message_id;

    // A command, or a reply aimed at some other message, is not the note we asked for
    if (
      !entry ||
      text.trim().startsWith('/') ||
      (replyTo !== undefined && replyTo !== entry.messageId)
    ) {
      await next();
      return;
    }

    const noteText = parseNoteInput(text);
    if (!noteText) {
      // Still waiting: the next message gets another chance
      await ctx.reply(`Заметка длиннее ${MAX_NOTE_LENGTH} символов — сократи и пришли ещё раз.`);
      return;
    }

    const note = deps.settings.addNote(noteText);
    pending.delete(chatId);
    if (!note) {
      await ctx.reply(`Заметок уже ${MAX_NOTES} — удали лишние и добавь заново.`);
      return;
    }

    // The note is now in the list above; keep the chat tidy
    await ctx.deleteMessage().catch(() => undefined);
    const { text: listText, keyboard } = notesView(deps.settings.get());
    await ignoreNotModified(
      ctx.api.editMessageText(chatId, entry.messageId, listText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }),
    );
  });
}

import type { Bot, Context } from 'grammy';
import { nowSerialIn } from '../../domain/dates.js';
import { toRow, validate } from '../../domain/operation.js';
import { logger } from '../../logger.js';
import type { ImportSession, ImportStage } from '../../state/imports.js';
import { parseRowNumbers } from '../../statement/pick.js';
import { renderImportList } from '../../statement/summary.js';
import type { AppDeps } from '../deps.js';
import {
  CARDS_PER_PRESS,
  deleteWritten,
  editWritten,
  openItemDraft,
  openRows,
} from '../import-items.js';
import {
  analyzeInBackground,
  IMPORT_PREFIX,
  MAX_STATEMENT_BYTES,
  redrawImport,
  startImport,
  statementKind,
} from '../statement-flow.js';
import { downloadTelegramFile } from '../telegram.js';

/** Reply-picked list messages remembered per import: older lists stop answering to numbers. */
const LISTS_KEPT = 10;
const ACTION = new RegExp(`^${IMPORT_PREFIX}([0-9a-f]+):([a-z])(?::(\\d+))?$`);

async function writeReady(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  if (deps.health.headerProblems.length > 0) {
    await ctx.answerCallbackQuery({
      text: 'Запись отключена: шапка листа «Операции» не совпадает с ожидаемой. Исправь и нажми /refresh.',
      show_alert: true,
    });
    return;
  }
  const ref = await deps.refs.get();
  const ready = session.items
    .filter((item) => item.status === 'ready')
    .sort((a, b) => a.op.date.localeCompare(b.op.date) || a.row - b.row);
  // Accounts or categories may have changed in the sheet since the analysis
  for (const item of ready) if (validate(item.op, ref).length > 0) item.status = 'doubtful';
  const valid = ready.filter((item) => item.status === 'ready');
  if (valid.length === 0) {
    await ctx.answerCallbackQuery('Нечего записывать');
    await redrawImport(ctx, deps, session);
    return;
  }

  await ctx.answerCallbackQuery('Записываю…');
  const addedAt = nowSerialIn(deps.env.BOT_TIMEZONE);
  try {
    const written = await deps.repo.appendMany(valid.map((item) => toRow(item.op, addedAt)));
    session.written.push(...written);
    valid.forEach((item, i) => {
      item.status = 'written';
      item.written = written[i];
    });
    session.stage = 'done';
  } catch (error) {
    logger.error({ error }, 'Failed to write imported operations');
    await ctx.reply('⚠️ Не удалось записать в таблицу — попробуй ещё раз.');
  }
  await redrawImport(ctx, deps, session);
}

async function openDoubtful(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  const batch = session.items
    .filter((item) => item.status === 'doubtful')
    .slice(0, CARDS_PER_PRESS);
  await ctx.answerCallbackQuery();
  for (const item of batch) await openItemDraft(ctx, deps, { session, item }, session.messageId);
  await redrawImport(ctx, deps, session);
}

async function sendList(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  await ctx.answerCallbackQuery();
  const ref = await deps.refs.get();
  const sent: number[] = [];
  for (const chunk of renderImportList(session, ref)) {
    const message = await ctx.reply(chunk, {
      parse_mode: 'HTML',
      reply_parameters:
        session.messageId === undefined ? undefined : { message_id: session.messageId },
    });
    sent.push(message.message_id);
  }
  session.listMessageIds = [...(session.listMessageIds ?? []), ...sent].slice(-LISTS_KEPT);
}

async function undoImport(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  await ctx.answerCallbackQuery('Убираю…');
  const total = session.written.length;
  const cleared = await deps.repo.clearMany(session.written);
  session.stage = 'undone';
  await redrawImport(ctx, deps, session);
  if (cleared < total) {
    await ctx.reply(
      `Убрал ${cleared} из ${total}. Остальные строки изменили или отсортировали — проверь их в таблице вручную.`,
    );
  }
}

async function cancelImport(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  session.stage = 'cancelled';
  await ctx.answerCallbackQuery();
  await redrawImport(ctx, deps, session);
}

type Action = (ctx: Context, deps: AppDeps, session: ImportSession, arg?: number) => Promise<void>;

const ACTIONS: Record<string, Action> = {
  w: writeReady,
  c: openDoubtful,
  l: sendList,
  u: undoImport,
  x: cancelImport,
  e: editWritten,
  d: deleteWritten,
};

/** Stages in which each button still means something; a stale press is turned away. */
const ALLOWED: Record<string, ImportStage[]> = {
  a: ['account'],
  w: ['review', 'done'],
  c: ['review', 'done'],
  l: ['review', 'done'],
  // A card saved on its own writes a row while the rest still waits for «Записать»
  u: ['review', 'done'],
  x: ['account', 'review'],
  e: ['review', 'done'],
  d: ['review', 'done'],
};

async function pickAccount(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
  index: number,
): Promise<void> {
  const account = session.candidates[index];
  if (!account) {
    await ctx.answerCallbackQuery('Список устарел');
    return;
  }
  await ctx.answerCallbackQuery();
  session.account = account;
  analyzeInBackground(ctx, deps, session);
}

async function pickRows(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
  text: string,
): Promise<void> {
  if (session.stage !== 'review' && session.stage !== 'done') {
    await ctx.reply('Этот импорт уже закрыт — пришли выписку заново.');
    return;
  }
  if (session.busy) {
    await ctx.reply('Подожди, ещё работаю над выпиской…');
    return;
  }
  const rows = parseRowNumbers(text);
  if (rows.length === 0) {
    await ctx.reply('Ответь номерами строк из списка: «4 6 12» или «4-8».');
    return;
  }
  session.busy = true;
  try {
    await openRows(ctx, deps, session, rows);
  } finally {
    session.busy = false;
  }
}

export function registerStatementHandlers(bot: Bot, deps: AppDeps): void {
  // Other documents (images sent as files) fall through to the input handlers
  bot.on('message:document', async (ctx, next) => {
    const { mime_type: mimeType, file_name: name, file_size: size } = ctx.message.document;
    const kind = statementKind(mimeType, name);
    if (!kind) return next();
    if (size !== undefined && size > MAX_STATEMENT_BYTES) {
      await ctx.reply('Выписка больше 5 МБ — выгрузи период покороче.');
      return;
    }
    let data: Buffer;
    try {
      data = Buffer.from(await downloadTelegramFile(ctx, deps.env.BOT_TOKEN));
    } catch (error) {
      logger.error({ error }, 'Failed to download a statement');
      await ctx.reply('⚠️ Не удалось скачать файл — попробуй ещё раз.');
      return;
    }
    await startImport(ctx, deps, { kind, data, name: name ?? `statement.${kind}` });
  });

  // A reply with row numbers to the summary or the list opens those rows; other text passes on
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    const session =
      replyTo === undefined ? undefined : deps.statements.imports.byMessage(ctx.chat.id, replyTo);
    if (!session) return next();
    await pickRows(ctx, deps, session, ctx.message.text);
  });

  bot.callbackQuery(ACTION, async (ctx) => {
    const [, id = '', action = '', arg] = ctx.match as RegExpMatchArray;
    const session = deps.statements.imports.get(id);
    if (!session || session.chatId !== ctx.chat?.id) {
      await ctx.answerCallbackQuery({
        text: 'Импорт устарел — пришли выписку заново.',
        show_alert: true,
      });
      return;
    }
    if (session.busy) {
      await ctx.answerCallbackQuery('Подожди, ещё работаю над выпиской…');
      return;
    }

    if (!ALLOWED[action]?.includes(session.stage)) {
      await ctx.answerCallbackQuery('Эта кнопка уже неактуальна');
      return;
    }
    // Analysis after the account is chosen runs in the background and holds `busy` itself
    if (action === 'a') return pickAccount(ctx, deps, session, Number(arg));

    session.busy = true;
    try {
      await ACTIONS[action]?.(ctx, deps, session, arg === undefined ? undefined : Number(arg));
    } finally {
      session.busy = false;
    }
  });
}

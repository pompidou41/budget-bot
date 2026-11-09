import type { Bot, Context } from 'grammy';
import { nowSerialIn } from '../../domain/dates.js';
import { toRow, validate } from '../../domain/operation.js';
import { logger } from '../../logger.js';
import type { ImportSession, ImportStage } from '../../state/imports.js';
import { renderImportList } from '../../statement/summary.js';
import type { AppDeps } from '../deps.js';
import { showDraft } from '../show-draft.js';
import {
  analyzeInBackground,
  IMPORT_PREFIX,
  MAX_STATEMENT_BYTES,
  redrawImport,
  startImport,
  statementKind,
} from '../statement-flow.js';
import { downloadTelegramFile } from '../telegram.js';

/** Cards opened per «⚠️ Проверить» press; the button stays while more are left. */
const CARDS_PER_PRESS = 15;
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
    for (const item of valid) item.status = 'written';
    session.stage = 'done';
  } catch (error) {
    logger.error({ error }, 'Failed to write imported operations');
    await ctx.reply('⚠️ Не удалось записать в таблицу — попробуй ещё раз.');
  }
  await redrawImport(ctx, deps, session);
}

async function openDoubtful(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  const ref = await deps.refs.get();
  const batch = session.items
    .filter((item) => item.status === 'doubtful')
    .slice(0, CARDS_PER_PRESS);
  await ctx.answerCallbackQuery();
  for (const item of batch) {
    const row = session.statement.rows.find((r) => r.index === item.row);
    const source = [row?.description, row?.counterparty].filter(Boolean).join(' · ');
    const draft = deps.drafts.create(session.chatId, item.op, {
      duplicate: item.duplicate,
      note: `Из выписки, строка ${item.row}: ${source}`,
    });
    item.status = 'drafted';
    await showDraft(ctx, draft, ref, session.messageId);
  }
  await redrawImport(ctx, deps, session);
}

async function sendList(ctx: Context, deps: AppDeps, session: ImportSession): Promise<void> {
  await ctx.answerCallbackQuery();
  const ref = await deps.refs.get();
  for (const chunk of renderImportList(session, ref)) {
    await ctx.reply(chunk, {
      parse_mode: 'HTML',
      reply_parameters:
        session.messageId === undefined ? undefined : { message_id: session.messageId },
    });
  }
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

type Action = (ctx: Context, deps: AppDeps, session: ImportSession) => Promise<void>;

const ACTIONS: Record<string, Action> = {
  w: writeReady,
  c: openDoubtful,
  l: sendList,
  u: undoImport,
  x: cancelImport,
};

/** Stages in which each button still means something; a stale press is turned away. */
const ALLOWED: Record<string, ImportStage[]> = {
  a: ['account'],
  w: ['review', 'done'],
  c: ['review', 'done'],
  l: ['review', 'done'],
  u: ['done'],
  x: ['account', 'review'],
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
      await ACTIONS[action]?.(ctx, deps, session);
    } finally {
      session.busy = false;
    }
  });
}

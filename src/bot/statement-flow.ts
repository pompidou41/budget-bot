import { InlineKeyboard, type Context } from 'grammy';
import { describeMatch, sheetMovements } from '../domain/duplicates.js';
import { escapeHtml } from '../domain/format.js';
import { findAccount, type Reference } from '../domain/reference.js';
import { logger } from '../logger.js';
import type { ImportSession } from '../state/imports.js';
import { resolveAccount } from '../statement/account.js';
import { bookingHistory } from '../statement/history.js';
import { missingFromStatement, planImport, rowToOperation } from '../statement/plan.js';
import {
  coveredDates,
  StatementFormatError,
  verifyBalances,
  type Statement,
} from '../statement/statement.js';
import { accountLabel, renderImportSummary } from '../statement/summary.js';
import { parseWorkbook, readWorkbook } from '../statement/xlsx.js';
import type { AppDeps } from './deps.js';
import { describeError, ignoreNotModified, inBackground } from './telegram.js';

export const IMPORT_PREFIX = 'i:';
export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
/** Beyond this the summary stops being readable and the model calls pile up. */
const MAX_ROWS = 500;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type StatementKind = 'xlsx' | 'pdf';

export function statementKind(mimeType?: string, fileName?: string): StatementKind | null {
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(fileName ?? '')) return 'pdf';
  if (mimeType === XLSX_MIME || /\.xlsx$/i.test(fileName ?? '')) return 'xlsx';
  return null;
}

export function importCallback(session: ImportSession, action: string, arg?: number): string {
  return `${IMPORT_PREFIX}${session.id}:${action}${arg === undefined ? '' : `:${arg}`}`;
}

export function importKeyboard(session: ImportSession, ref: Reference): InlineKeyboard | undefined {
  const cb = (action: string, arg?: number) => importCallback(session, action, arg);
  const keyboard = new InlineKeyboard();
  if (session.stage === 'account') {
    session.candidates.forEach((id, i) => keyboard.text(accountLabel(ref, id), cb('a', i)).row());
    return keyboard.text('❌ Отмена', cb('x'));
  }
  if (session.stage !== 'review' && session.stage !== 'done') return undefined;

  const ready = session.items.filter((i) => i.status === 'ready').length;
  const doubtful = session.items.filter((i) => i.status === 'doubtful').length;
  if (ready > 0) keyboard.text(`💾 Записать ${ready}`, cb('w')).row();
  if (doubtful > 0) keyboard.text(`⚠️ Проверить ${doubtful}`, cb('c'));
  keyboard.text('📋 Список', cb('l')).row();
  return session.written.length > 0
    ? keyboard.text('↩️ Отменить импорт', cb('u'))
    : keyboard.text('❌ Отмена', cb('x'));
}

export async function redrawImport(
  ctx: Context,
  deps: AppDeps,
  session: ImportSession,
): Promise<void> {
  if (session.messageId === undefined) return;
  const ref = await deps.refs.get();
  await ignoreNotModified(
    ctx.api.editMessageText(session.chatId, session.messageId, renderImportSummary(session), {
      parse_mode: 'HTML',
      reply_markup: importKeyboard(session, ref),
    }),
  );
}

async function readStatement(
  deps: AppDeps,
  kind: StatementKind,
  file: Buffer,
  fileName: string,
): Promise<Statement> {
  if (kind === 'xlsx') return parseWorkbook(await readWorkbook(file));
  const dataUrl = `data:application/pdf;base64,${file.toString('base64')}`;
  return deps.statements.extractor.extract({ filename: fileName, dataUrl });
}

/** Books every row of the statement and sorts it against the sheet; fills the session. */
async function analyze(deps: AppDeps, session: ImportSession): Promise<void> {
  const account = session.account;
  if (!account) throw new Error('Import has no account');
  const { statement } = session;
  // Fresh balances and history: the summary compares against what the sheet holds right now
  const [ref, rows, txns] = await Promise.all([
    deps.refs.reload(),
    deps.repo.readRows(),
    deps.data.reload(),
  ]);
  const recorded = sheetMovements(rows);
  const guesses = await deps.statements.classifier.classify(
    statement.rows,
    {
      account,
      holder: statement.holder,
      history: bookingHistory(txns, account),
      notes: deps.settings.get().notes,
    },
    ref,
  );
  const ops = statement.rows.map((r) => rowToOperation(r, guesses.get(r.index), account, ref));
  const sure = statement.rows.map((r) => guesses.get(r.index)?.sure ?? false);
  const { items, matched } = planImport(statement.rows, ops, sure, recorded, ref);
  const dates = coveredDates(statement.rows);

  session.items = items;
  session.missing = dates
    ? missingFromStatement(recorded, matched, account, dates).map((m) => describeMatch(m, ref))
    : [];
  session.sheetBalance = findAccount(ref, account)?.balance ?? null;
  session.stage = 'review';
}

/** Analyses in the background — a long statement takes the model a minute or more. */
export function analyzeInBackground(ctx: Context, deps: AppDeps, session: ImportSession): void {
  const work = async () => {
    session.busy = true;
    try {
      if (session.messageId !== undefined) {
        await ctx.api.editMessageText(
          session.chatId,
          session.messageId,
          `🤖 Разбираю ${session.statement.rows.length} операций…`,
        );
      }
      await analyze(deps, session);
      await redrawImport(ctx, deps, session);
    } catch (error) {
      logger.error({ error }, 'Failed to analyse a statement');
      session.stage = 'cancelled';
      if (session.messageId !== undefined) {
        await ctx.api.editMessageText(
          session.chatId,
          session.messageId,
          `⚠️ Не получилось разобрать выписку: ${escapeHtml(describeError(error))}\n\nПришли её ещё раз.`,
          { parse_mode: 'HTML' },
        );
      }
    } finally {
      session.busy = false;
      // Background work outlives the update, whose middleware already wrote the state down
      deps.statements.imports.flush();
    }
  };
  inBackground(work(), 'statement analysis');
}

async function readAndOpen(
  ctx: Context,
  deps: AppDeps,
  file: { kind: StatementKind; data: Buffer; name: string },
  messageId: number,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  try {
    const statement = await readStatement(deps, file.kind, file.data, file.name);
    if (statement.rows.length > MAX_ROWS) {
      await ctx.api.editMessageText(
        chatId,
        messageId,
        `В выписке ${statement.rows.length} операций — разбираю до ${MAX_ROWS}. Выгрузи период покороче.`,
      );
      return;
    }
    const session = deps.statements.imports.create(chatId, statement, verifyBalances(statement));
    session.messageId = messageId;
    const choice = resolveAccount(statement, await deps.refs.reload());
    session.candidates = choice.candidates.map((a) => a.id);
    session.account = choice.account;
    if (session.account) {
      analyzeInBackground(ctx, deps, session);
      return;
    }
    await redrawImport(ctx, deps, session);
    deps.statements.imports.flush();
  } catch (error) {
    logger.error({ error, kind: file.kind }, 'Failed to read a statement');
    const reason = error instanceof StatementFormatError ? error.message : describeError(error);
    await ctx.api.editMessageText(
      chatId,
      messageId,
      `⚠️ Не получилось прочитать выписку: ${escapeHtml(reason)}`,
      { parse_mode: 'HTML' },
    );
  }
}

/** Entry point for an uploaded statement file; reading a PDF runs in the background too. */
export async function startImport(
  ctx: Context,
  deps: AppDeps,
  file: { kind: StatementKind; data: Buffer; name: string },
): Promise<void> {
  const text = file.kind === 'pdf' ? '⏳ Читаю PDF — это около минуты…' : '⏳ Читаю выписку…';
  const progress = await ctx.reply(text, {
    reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id } : undefined,
  });
  inBackground(readAndOpen(ctx, deps, file, progress.message_id), 'statement reading');
}

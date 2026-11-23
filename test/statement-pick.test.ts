import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRowNumbers } from '../src/statement/pick.js';
import {
  deps,
  documentUpdate,
  FIXTURE,
  lastSummary,
  press,
  replyUpdate,
  testBot,
  type Call,
} from './statement-bot.js';

afterEach(() => vi.restoreAllMocks());

describe('parseRowNumbers', () => {
  it.each([
    ['4 6 12', [4, 6, 12]],
    ['#6, #4', [4, 6]],
    ['4-6 и 5', [4, 5, 6]],
    ['4–6', [4, 5, 6]],
    ['поправь', []],
    ['1-2026', []],
  ])('%s → %j', (text, rows) => {
    expect(parseRowNumbers(text)).toEqual(rows);
  });
});

type Button = { text: string; callback_data?: string };

function buttons(call: Call | undefined): Button[] {
  const markup = call?.payload.reply_markup as { inline_keyboard: Button[][] } | undefined;
  return markup?.inline_keyboard.flat() ?? [];
}

/** Message id the fake API gave the call: 900 + its 1-based position. */
function idOf(calls: Call[], call: Call): number {
  return 900 + calls.indexOf(call) + 1;
}

async function importedBot() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(FIXTURE));
  const appDeps = deps();
  const harness = testBot(appDeps);
  await harness.bot.handleUpdate(documentUpdate());
  await vi.waitFor(() => expect(harness.texts().at(-1)).toContain('готовы к записи'));
  const summary = lastSummary(harness.calls);
  const id = summary.data[0]!.split(':')[1]!;
  await harness.bot.handleUpdate(press(`i:${id}:l`, summary.messageId));
  const list = harness.calls.find((c) => String(c.payload.text).includes('Ответь на этот список'));
  return {
    ...harness,
    appDeps,
    id,
    summaryId: summary.messageId,
    listId: idOf(harness.calls, list!),
  };
}

describe('picking statement rows from the list', () => {
  it('opens cards by number; a dropped card leaves the batch', async () => {
    const { bot, calls, texts, appDeps, listId } = await importedBot();

    await bot.handleUpdate(replyUpdate('2 9 99', listId));

    const card = calls.find((c) => buttons(c).some((b) => b.text === '🚫 Не записывать'));
    expect(String(card?.payload.text)).toContain('Из выписки, строка 2');
    const notes = calls.find((c) => String(c.payload.text).includes('такой строки'));
    expect(String(notes?.payload.text)).toMatch(/#9 была в таблице.*\n#99 — такой строки/);

    const cancel = buttons(card).find((b) => b.text === '🚫 Не записывать')!.callback_data!;
    await bot.handleUpdate(press(cancel, idOf(calls, card!)));
    expect(texts().at(-1)).toContain('🚫 1 не записываю');
    expect(texts().at(-1)).toContain('🆕 10 готовы к записи');
    expect(appDeps.repo.append).not.toHaveBeenCalled();
  });

  it('a written row can be deleted or fixed and written again', async () => {
    const { bot, calls, texts, appDeps, id, summaryId, listId } = await importedBot();
    await bot.handleUpdate(press(`i:${id}:w`, summaryId));
    const written = vi.mocked(appDeps.repo.appendMany).mock.calls[0]![0];

    await bot.handleUpdate(replyUpdate('3 4', listId));
    const cards = calls.filter((c) => buttons(c).some((b) => b.text === '🗑 Удалить из таблицы'));
    expect(cards).toHaveLength(2);

    // First tap: a confirmation made from the live row, nothing deleted yet
    const remove = buttons(cards[0]).find((b) => b.text === '🗑 Удалить из таблицы')!;
    await bot.handleUpdate(press(remove.callback_data!, idOf(calls, cards[0]!)));
    expect(appDeps.repo.remove).not.toHaveBeenCalled();
    const ask = calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(ask.payload.text)).toContain('Удалить эту строку из таблицы (строка ');
    const yes = buttons(ask).find((b) => b.text === '🗑 Да, удалить')!;
    expect(buttons(ask).map((b) => b.text)).toContain('Оставить');

    await bot.handleUpdate(press(yes.callback_data!, idOf(calls, ask)));
    const [[target]] = vi.mocked(appDeps.repo.remove).mock.calls[0]!;
    expect(written).toContainEqual(target!.values);
    expect(target!.row).toBeGreaterThanOrEqual(100);
    expect(texts().at(-1)).toContain('🚫 1 не записываю');

    const fix = buttons(cards[1]).find((b) => b.text === '✏️ Исправить')!;
    await bot.handleUpdate(press(fix.callback_data!, idOf(calls, cards[1]!)));
    expect(appDeps.repo.remove).toHaveBeenCalledOnce();
    const askFix = calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(askFix.payload.text)).toContain('будет убрана из таблицы');
    const goOn = buttons(askFix).find((b) => b.text.includes('Да, убрать'))!;
    await bot.handleUpdate(press(goOn.callback_data!, idOf(calls, askFix)));
    expect(appDeps.repo.remove).toHaveBeenCalledTimes(2);
    const redrawn = calls.filter((c) => c.method === 'editMessageText').at(-2)!;
    expect(String(redrawn.payload.text)).toContain('Поправь и сохрани заново');
    const save = buttons(redrawn).find((b) => b.text === '✅ Сохранить')!.callback_data!;
    await bot.handleUpdate(press(save, idOf(calls, cards[1]!)));

    expect(appDeps.repo.append).toHaveBeenCalledOnce();
    expect(texts().at(-1)).toContain('✅ Записано 10');
  });

  it('answers a reply without numbers with a hint', async () => {
    const { bot, calls, listId } = await importedBot();
    await bot.handleUpdate(replyUpdate('что это?', listId));
    expect(calls.at(-1)?.payload.text).toContain('Ответь номерами строк');
  });
});

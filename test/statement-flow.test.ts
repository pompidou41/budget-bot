import { afterEach, describe, expect, it, vi } from 'vitest';
import { deps, documentUpdate, FIXTURE, lastSummary, press, testBot } from './statement-bot.js';

afterEach(() => vi.restoreAllMocks());

describe('statement import', () => {
  it('reads the file, skips what is recorded, writes the rest and undoes it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(FIXTURE));
    const appDeps = deps();
    const { bot, calls, texts } = testBot(appDeps);

    await bot.handleUpdate(documentUpdate());
    await vi.waitFor(() => expect(texts().at(-1)).toContain('готовы к записи'));

    const summary = texts().at(-1)!;
    expect(summary).toContain('CREDO_GEL · 08.10 – 12.10');
    expect(summary).toContain('12 операций');
    expect(summary).toContain('⏭ 1 уже в таблице');
    expect(summary).toContain('🆕 11 готовы к записи');
    const classify = vi.mocked(appDeps.statements.classifier.classify);
    expect(classify.mock.calls[0]?.[1]).toMatchObject({
      account: 'CREDO_GEL',
      holder: 'ტესტ მფლობელი',
    });

    const { data, messageId } = lastSummary(calls);
    expect(data).toEqual([
      expect.stringMatching(/^i:[0-9a-f]+:w$/),
      expect.any(String),
      expect.any(String),
    ]);
    const id = data[0]!.split(':')[1]!;
    await bot.handleUpdate(press(`i:${id}:w`, messageId));

    const written = vi.mocked(appDeps.repo.appendMany).mock.calls[0]?.[0] ?? [];
    expect(written).toHaveLength(11);
    // Sorted by the date of the operation, not by booking
    expect(written.map((row) => row[0])).toEqual([...written.map((row) => row[0])].sort());
    expect(written.find((row) => row[3] === 1140.84)?.[1]).toBe('Доход');
    expect(texts().at(-1)).toContain('✅ Записано 11 · строки 100–110');

    await bot.handleUpdate(press(`i:${id}:u`, messageId));
    expect(appDeps.repo.clearMany).toHaveBeenCalledOnce();
    expect(texts().at(-1)).toContain('Импорт отменён');

    // A stale button after the undo does nothing
    await bot.handleUpdate(press(`i:${id}:w`, messageId));
    expect(appDeps.repo.appendMany).toHaveBeenCalledOnce();
    expect(calls.at(-1)?.payload.text).toBe('Эта кнопка уже неактуальна');
  });

  it('passes other documents on to the input handlers', async () => {
    const appDeps = deps();
    const { bot, calls } = testBot(appDeps);
    const update = documentUpdate();
    update.message.document.file_name = 'notes.txt';
    update.message.document.mime_type = 'text/plain';

    await bot.handleUpdate(update);

    expect(calls.map((c) => c.payload.text)).toEqual([
      'Понимаю текст, голосовые, картинки и выписки PDF или XLSX.',
    ]);
  });
});

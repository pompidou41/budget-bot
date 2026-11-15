import { describe, expect, it } from 'vitest';
import { documentView } from '../src/domain/document.js';
import { deps, OWNER, testBot } from './statement-bot.js';

const ID = 'abc';

describe('documentView', () => {
  it('links the table and the known sheets that exist, in a fixed order', () => {
    const view = documentView(ID, {
      title: 'Расходы/доходы',
      tabs: [
        { gid: 7, title: 'Недели' },
        { gid: 0, title: 'Операции' },
        { gid: 3, title: 'Sheet15' },
      ],
    });
    expect(view.text).toContain('«Расходы/доходы»');
    expect(view.links).toEqual([
      { label: '📗 Открыть таблицу', url: 'https://docs.google.com/spreadsheets/d/abc/edit' },
      { label: 'Операции', url: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0' },
      { label: 'Недели', url: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=7' },
    ]);
  });

  it('still gives the link when the sheet list could not be read', () => {
    const view = documentView(ID, null);
    expect(view.links).toHaveLength(1);
    expect(view.text).toContain('https://docs.google.com/spreadsheets/d/abc/edit');
  });
});

describe('/document', () => {
  it('replies with URL buttons, the sheet ones read from the workbook', async () => {
    const appDeps = {
      ...deps(),
      workbook: { get: async () => ({ title: 'Т', tabs: [{ gid: 5, title: 'Капитал' }] }) },
    };
    appDeps.env.SPREADSHEET_ID = ID;
    const { bot, calls } = testBot(appDeps);
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: OWNER, type: 'private' },
        from: { id: OWNER, is_bot: false, first_name: 'o' },
        text: '/document',
        entities: [{ type: 'bot_command', offset: 0, length: 9 }],
      },
    });
    const markup = calls[0]?.payload.reply_markup as { inline_keyboard: { url: string }[][] };
    expect(markup.inline_keyboard.flat().map((b) => b.url)).toEqual([
      'https://docs.google.com/spreadsheets/d/abc/edit',
      'https://docs.google.com/spreadsheets/d/abc/edit#gid=5',
    ]);
  });
});

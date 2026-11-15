import { InlineKeyboard, type Bot } from 'grammy';
import { documentView, type Workbook } from '../../domain/document.js';
import { logger } from '../../logger.js';
import type { AppDeps } from '../deps.js';

export function registerDocument(bot: Bot, deps: AppDeps): void {
  bot.command('document', async (ctx) => {
    let workbook: Workbook | null = null;
    try {
      workbook = await deps.workbook.get();
    } catch (error) {
      // The link alone still does the job; only the per-sheet buttons are lost
      logger.warn({ error }, 'Failed to read spreadsheet tabs');
    }
    const { text, links } = documentView(deps.env.SPREADSHEET_ID, workbook);
    const [main, ...tabs] = links;
    const keyboard = new InlineKeyboard();
    if (main) keyboard.url(main.label, main.url).row();
    tabs.forEach((tab, i) => {
      keyboard.url(tab.label, tab.url);
      if (i % 3 === 2) keyboard.row();
    });
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });
}

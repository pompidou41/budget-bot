import { describe, expect, it } from 'vitest';
import { transcriptFrom, transcriptLine } from '../src/bot/voice.js';
import { stripHtml } from '../src/bot/telegram.js';

describe('transcriptFrom', () => {
  it('reads back the transcript the bot showed above its reply', () => {
    // What Telegram returns as message text: our markup stripped, the transcript on the first line
    const shown = stripHtml(
      `${transcriptLine('почему в сентябре так много на еду?')}\n\n🤷 Не нашёл операций.`,
    );
    expect(transcriptFrom(shown)).toBe('почему в сентябре так много на еду?');
  });

  it('finds nothing in a message without a transcript', () => {
    expect(transcriptFrom('🤷 Не нашёл операций.')).toBeUndefined();
    expect(transcriptFrom(undefined)).toBeUndefined();
  });
});

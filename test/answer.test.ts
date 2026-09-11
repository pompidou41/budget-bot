import { describe, expect, it } from 'vitest';
import { renderAnswer, type Answer } from '../src/domain/answer.js';
import { stripHtml } from '../src/bot/telegram.js';

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    headline: 'На еду ушло $612 за 3 месяца',
    sections: [],
    seriesTitle: '',
    seriesUnit: '$',
    series: [],
    note: '',
    ...overrides,
  };
}

describe('renderAnswer', () => {
  it('escapes everything the model wrote', () => {
    const text = renderAnswer(
      answer({
        headline: 'Траты <b>выросли</b> & дорого',
        sections: [{ title: 'a < b', bullets: ['<script>alert(1)</script>'] }],
        note: '5 > 3',
      }),
    );

    expect(text).toContain('Траты &lt;b&gt;выросли&lt;/b&gt; &amp; дорого');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('5 &gt; 3');
    // Only our own tags survive
    expect(text.match(/<(?!\/?(b|i|pre)>)/g)).toBeNull();
  });

  it('draws the series as a monospace bar chart', () => {
    const text = renderAnswer(
      answer({
        seriesTitle: 'Food по месяцам',
        series: [
          { label: 'июн 26', value: 612 },
          { label: 'июл 26', value: 306 },
        ],
      }),
    );

    expect(text).toContain('<b>Food по месяцам</b>');
    expect(text).toContain('<pre>');
    const [first, second] = text.slice(text.indexOf('<pre>')).split('\n');
    // The peak fills the bar, half the value fills half of it
    expect(first).toContain('$612');
    expect(second).toContain('$306');
    expect((first?.match(/█/g) ?? []).length).toBe(12);
    expect((second?.match(/█/g) ?? []).length).toBe(6);
  });

  it('formats percent and custom units', () => {
    const percent = renderAnswer(
      answer({ seriesUnit: '%', series: [{ label: 'рост', value: 27 }] }),
    );
    expect(percent).toContain('27%');

    const rubles = renderAnswer(
      answer({ seriesUnit: 'RUB', series: [{ label: 'июн', value: 1500 }] }),
    );
    expect(rubles).toContain('RUB');
  });

  it('drops whole blocks instead of cutting a tag in half', () => {
    const text = renderAnswer(
      answer({
        sections: Array.from({ length: 4 }, (_, i) => ({
          title: `Блок ${i}`,
          bullets: [Array.from({ length: 40 }, () => 'длинная строка про траты').join(' ')],
        })),
      }),
    );

    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('ответ сокращён');
    // No dangling "<b" or half-written entity at the end
    expect(text.endsWith('</i>')).toBe(true);
  });

  it('never returns an empty message', () => {
    expect(renderAnswer(answer({ headline: '' }))).toContain('🤷');
  });
});

describe('stripHtml', () => {
  it('unwraps our own markup for the plain-text fallback', () => {
    expect(stripHtml('<b>Итого</b> &lt;5&gt; &amp; всё')).toBe('Итого <5> & всё');
  });
});

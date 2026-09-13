import { describe, expect, it } from 'vitest';
import { renderAnswer, renderAnswerRich, type Answer } from '../src/domain/answer.js';
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

describe('renderAnswerRich', () => {
  it('uses headings and lists instead of bold lines', () => {
    const rich = renderAnswerRich({
      headline: 'Еда съедает $600 в месяц',
      sections: [{ title: 'Разбор', bullets: ['Рестораны — половина', 'Продукты стабильны'] }],
      seriesTitle: '',
      seriesUnit: '',
      series: [],
      note: '',
    });

    expect(rich).toContain('<h3>🧠 Еда съедает $600 в месяц</h3>');
    expect(rich).toContain('<h4>Разбор</h4>');
    expect(rich).toContain('<li>Рестораны — половина</li>');
  });

  it('puts the series in a table with bars beside the figures', () => {
    const rich = renderAnswerRich({
      headline: '',
      sections: [],
      seriesTitle: 'Динамика',
      seriesUnit: '$',
      series: [
        { label: 'июн 26', value: 600 },
        { label: 'июл 26', value: 300 },
      ],
      note: '',
    });

    expect(rich).toContain('<table compact>');
    expect(rich).toContain('июн 26');
    expect(rich).toContain('█');
    expect(rich).toContain('$600');
  });

  it('escapes model text into attributes as well as markup', () => {
    const rich = renderAnswerRich({
      headline: 'a "b" <c> & d',
      sections: [],
      seriesTitle: '',
      seriesUnit: '',
      series: [],
      note: '',
    });

    expect(rich).toContain('a &#34;b&#34; &lt;c&gt; &amp; d');
  });

  it('falls back to a plain line when the model returned nothing', () => {
    const rich = renderAnswerRich({
      headline: '',
      sections: [],
      seriesTitle: '',
      seriesUnit: '',
      series: [],
      note: '',
    });

    expect(rich).toContain('переформулируй вопрос');
  });
});

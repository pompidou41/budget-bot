import { describe, expect, it } from 'vitest';
import { reviewResponseSchema, toReview } from '../src/ai/analyst.js';
import type { ReviewSignals } from '../src/analytics/signals.js';
import { reviewWindow } from '../src/analytics/signals.js';
import { parseReviewScope } from '../src/bot/handlers/review.js';
import { renderReviewHtml, renderReviewRich, type Review } from '../src/domain/review.js';

const signals: ReviewSignals = {
  window: reviewWindow('2026-09-16', 'week'),
  spent: 412,
  typical: 340,
  delta: 72,
  deltaPct: 72 / 340,
  txnCount: 23,
  oneOff: 0,
  income: 0,
  saved: 200,
  categories: [
    {
      category: 'Food',
      actual: 138,
      typical: 60,
      delta: 78,
      deltaPct: 1.3,
      count: 6,
      typicalCount: 3,
      avgTicket: 23,
      typicalTicket: 20,
      streakAbove: 3,
      isNew: false,
    },
  ],
  bigTxns: [],
  history: [
    { label: '31.08–06.09', value: 330 },
    { label: '07–13.09', value: 412 },
  ],
};

const review: Review = {
  headline: 'Неделя вышла на $72 дороже обычного',
  story: 'Почти вся разница — рестораны.',
  insights: [
    { tone: 'alert', title: 'Рестораны третью неделю', text: 'Это уже привычка, а не всплеск.' },
    { tone: 'good', title: 'Подушка растёт', text: 'Отложено $200.' },
  ],
  actions: [
    { action: 'Лимит $80 на рестораны', why: 'вернёт к обычному уровню', effect: '~$230 в месяц' },
  ],
  explain: 'Обычно — это сколько уходит в типичную неделю.',
  followUp: 'А что с такси?',
};

describe('renderReviewRich', () => {
  const rich = renderReviewRich(review, signals);

  it('leads with the explanation, not the table', () => {
    expect(rich.indexOf(review.headline)).toBeLessThan(rich.indexOf('Цифры по категориям'));
    expect(rich).toContain('<h4>💡 Что я заметил</h4>');
    expect(rich).toContain('⚠️ <b>Рестораны третью неделю</b>');
    expect(rich).toContain('<ol><li><b>Лимит $80 на рестораны</b>');
    expect(rich).toContain('<blockquote>📖');
  });

  it('takes the headline figures from the signals, never from the model text', () => {
    expect(rich).toContain('$412');
    expect(rich).toContain('+$72 (+21%)');
    expect(rich).toContain('Отложено');
  });

  it('keeps the detail tables collapsed and offers the other periods', () => {
    expect(rich).toContain('<details><summary>Цифры по категориям</summary><table');
    expect(rich).toContain('<tg-button type="disabled" style="primary">Прошлая неделя</tg-button>');
    expect(rich).toContain('data="v:month"');
    expect(rich).toContain('data="v:mtd"');
  });

  it('escapes model text, attributes included', () => {
    const hostile = renderReviewRich({ ...review, headline: 'a "b" <c> & d' }, signals);
    expect(hostile).toContain('a &#34;b&#34; &lt;c&gt; &amp; d');
  });

  it('omits empty sections instead of showing blank headings', () => {
    const bare = renderReviewRich(
      { ...review, insights: [], actions: [], explain: '', followUp: '' },
      signals,
    );
    expect(bare).not.toContain('Что я заметил');
    expect(bare).not.toContain('Что можно сделать');
    expect(bare).not.toContain('<blockquote>');
    expect(bare).toContain('Ответь на это сообщение');
  });
});

describe('renderReviewHtml', () => {
  it('uses only ordinary Telegram HTML', () => {
    const html = renderReviewHtml(review, signals);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<tg-button');
    expect(html).toContain('<pre>');
    expect(html).toContain('💡 <b>Что я заметил</b>');
  });

  it('stays under the message limit by dropping trailing tables, not the words', () => {
    const long = renderReviewHtml({ ...review, story: 'слово '.repeat(600) }, signals);
    expect(long.length).toBeLessThanOrEqual(3900);
    expect(long).toContain(review.headline);
  });
});

describe('parseReviewScope', () => {
  it('reads the period from plain words', () => {
    expect(parseReviewScope('')).toBe('week');
    expect(parseReviewScope('неделя')).toBe('week');
    expect(parseReviewScope('месяц')).toBe('month');
    expect(parseReviewScope('этот месяц')).toBe('mtd');
    expect(parseReviewScope('текущий')).toBe('mtd');
  });
});

describe('toReview', () => {
  it('survives a sloppy model: bad tone, empty insights, too many of them', () => {
    const raw = reviewResponseSchema.parse({
      headline: '  Итог  ',
      story: 'x',
      insights: [
        { tone: 'panic', title: 'a', text: 'один' },
        { tone: 'good', title: 'b', text: '' },
        ...Array.from({ length: 6 }, (_, i) => ({ tone: 'info', title: `t${i}`, text: `n${i}` })),
      ],
      actions: [{ action: '', why: 'нет действия', effect: '' }],
      explain: null,
      followUp: 'Что дальше?',
    });

    const result = toReview(raw);
    expect(result.headline).toBe('Итог');
    expect(result.insights[0]?.tone).toBe('info');
    expect(result.insights).toHaveLength(4);
    expect(result.insights.every((i) => i.text)).toBe(true);
    expect(result.actions).toHaveLength(0);
    expect(result.explain).toBe('');
  });
});

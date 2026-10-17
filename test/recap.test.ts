import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  lastClosedBucket,
  recapCaption,
  summarizeBucket,
  type BucketSummary,
} from '../src/analytics/buckets.js';
import type { Txn } from '../src/analytics/dataset.js';
import { photoKeyboard, reportKeyboard } from '../src/bot/keyboards.js';
import { decodeReport, DEFAULT_REPORT, type ReportState } from '../src/domain/report.js';
import { createRecapStore } from '../src/state/recap.js';

function txn(date: string, rub: number, category = 'Food', overrides: Partial<Txn> = {}): Txn {
  return {
    date,
    month: date.slice(0, 7),
    type: 'Расход',
    account: 'T_MAIN',
    toAccount: '',
    amount: rub,
    currency: 'RUB',
    usd: rub / 100,
    rub,
    category,
    subcategory: '',
    comment: '',
    oneOff: false,
    ...overrides,
  };
}

const K = 1000;
const BASELINE_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const RUB = { money: 'rub', oneOff: false } as const;

/** The same bucket in each of the six months before October, one spend per category. */
function history(slot: 1 | 2 | 3 | 4, spend: Record<string, number>): Txn[] {
  const day = ['01', '09', '17', '25'][slot - 1];
  return BASELINE_MONTHS.flatMap((month) =>
    Object.entries(spend).map(([category, rub]) => txn(`${month}-${day}`, rub, category)),
  );
}

describe('lastClosedBucket', () => {
  it('is the bucket before the one `today` is in', () => {
    expect(lastClosedBucket('2026-10-09')).toBe('2026-10-b1');
    expect(lastClosedBucket('2026-10-16')).toBe('2026-10-b1');
    expect(lastClosedBucket('2026-10-17')).toBe('2026-10-b2');
    expect(lastClosedBucket('2026-11-01')).toBe('2026-10-b4');
    expect(lastClosedBucket('2027-01-03')).toBe('2026-12-b4');
  });
});

describe('summarizeBucket', () => {
  it('takes «usual» from the same slot of earlier months, not from the buckets around it', () => {
    const txns = [
      // 1–8: 40 50 60 50 70 50 thousand → the middle is 50
      ...BASELINE_MONTHS.map((month, i) => txn(`${month}-02`, [40, 50, 60, 50, 70, 50][i]! * K)),
      // Every 9–16 is huge, and must not leak into the 1–8 comparison
      ...history(2, { Food: 200 * K }),
      txn('2026-10-03', 30 * K),
    ];

    const summary = summarizeBucket(txns, '2026-10-b1', RUB);

    expect(summary.total).toBe(30 * K);
    expect(summary.usual).toBe(50 * K);
    expect(summary.deltaPct).toBeCloseTo(-40);
    expect(summary.baselineMonths).toBe(6);
  });

  it('counts a month with nothing spent in that slot as a zero', () => {
    // Rent was paid in 4 of the 6 months: the usual 1–8 is the middle of 0 0 50 50 50 50
    const txns = BASELINE_MONTHS.slice(2).map((month) => txn(`${month}-01`, 50 * K));
    txns.push(txn('2026-04-20', 1 * K), txn('2026-05-20', 1 * K), txn('2026-10-02', 50 * K));

    expect(summarizeBucket(txns, '2026-10-b1', RUB).usual).toBe(50 * K);

    const sparse = [txn('2026-08-01', 50 * K), txn('2026-09-01', 50 * K), txn('2026-04-20', K)];
    sparse.push(txn('2026-05-20', K), txn('2026-06-20', K), txn('2026-07-20', K));
    // 0 0 0 0 50 50 → 0
    expect(summarizeBucket([...sparse, txn('2026-10-02', 10 * K)], '2026-10-b1', RUB).usual).toBe(
      0,
    );
  });

  it("names the biggest overspends and the biggest saving against the category's own usual", () => {
    const txns = [
      ...history(1, { Food: 10 * K, Housing: 30 * K, Education: 8 * K, Health: 2 * K }),
      txn('2026-10-02', 25 * K, 'Food'), //     +15 000
      txn('2026-10-02', 30 * K, 'Housing'), //  no change
      txn('2026-10-02', 3 * K, 'Education'), // −5 000
      txn('2026-10-02', 8 * K, 'Health'), //    +6 000, third in line
      txn('2026-10-02', 12 * K, 'Travel'), //   new: +12 000
    ];

    const summary = summarizeBucket(txns, '2026-10-b1', RUB);

    // Two overspends at most, the heaviest first; Health +6 000 is cut
    expect(summary.above.map((s) => [s.category, s.delta])).toEqual([
      ['Food', 15 * K],
      ['Travel', 12 * K],
    ]);
    expect(summary.below.map((s) => [s.category, s.delta])).toEqual([['Education', -5 * K]]);
    expect(summary.above[0]).toMatchObject({ actual: 25 * K, usual: 10 * K });
  });

  it('keeps only one saving even when there are several', () => {
    const txns = [
      ...history(1, { Food: 20 * K, Education: 8 * K, Transport: 6 * K }),
      txn('2026-10-02', 12 * K, 'Food'), // −8 000
      txn('2026-10-02', 3 * K, 'Education'), // −5 000
      txn('2026-10-02', 20 * K, 'Housing'),
    ];

    expect(summarizeBucket(txns, '2026-10-b1', RUB).below.map((s) => s.category)).toEqual(['Food']);
  });

  it("drops a swing that is small next to the category's usual (under 15%)", () => {
    // Housing 60 → 66: +6 000 is 7.9% of the bucket, but only 10% of Housing's usual
    const txns = [
      ...history(1, { Housing: 60 * K, Food: 10 * K }),
      txn('2026-10-02', 66 * K, 'Housing'),
    ];
    txns.push(txn('2026-10-03', 10 * K, 'Food'));

    const summary = summarizeBucket(txns, '2026-10-b1', RUB);
    expect(summary.above).toEqual([]);
    expect(summary.below).toEqual([]);
  });

  it('drops a swing that is small next to the bucket (under 5%)', () => {
    // Food 10 → 11.6: +16% of its usual, but 1 600 is only 2% of the 71 600 bucket
    const txns = [
      ...history(1, { Housing: 60 * K, Food: 10 * K }),
      txn('2026-10-02', 60 * K, 'Housing'),
    ];
    txns.push(txn('2026-10-03', 11_600, 'Food'));

    const summary = summarizeBucket(txns, '2026-10-b1', RUB);
    expect(summary.total).toBe(71_600);
    expect(summary.above).toEqual([]);
  });

  it('keeps a swing that sits exactly on the 5% threshold', () => {
    // Food usual 20 000, now 25 000 in a bucket of 100 000: +25% of its usual, exactly 5% of the bucket
    const txns = [
      ...history(1, { Food: 20 * K, Other: 80 * K }),
      txn('2026-10-02', 25 * K, 'Food'),
      txn('2026-10-02', 75 * K, 'Other'),
    ];

    expect(summarizeBucket(txns, '2026-10-b1', RUB).above.map((s) => s.category)).toEqual(['Food']);
  });

  it('compares the month so far with the same stretch of earlier months, from the second bucket on', () => {
    const txns = [
      // Earlier months: 1–8 is 40 000 and 9–16 is 60 000, so 100 000 by the 16th
      ...history(1, { Food: 40 * K }),
      ...history(2, { Food: 60 * K }),
      txn('2026-10-02', 30 * K),
      txn('2026-10-10', 50 * K),
    ];

    const summary = summarizeBucket(txns, '2026-10-b2', RUB);

    expect(summary.total).toBe(50 * K);
    expect(summary.usual).toBe(60 * K);
    expect(summary.monthToDate).toEqual({
      month: '2026-10',
      spent: 80 * K,
      usual: 100 * K,
      deltaPct: -20,
      throughDay: 16,
      complete: false,
    });
  });

  it('says nothing about the month so far after the first bucket: it would repeat the headline', () => {
    const txns = [...history(1, { Food: 40 * K }), txn('2026-10-02', 30 * K)];

    expect(summarizeBucket(txns, '2026-10-b1', RUB).monthToDate).toBeNull();
  });

  it('closes the month with the fourth bucket', () => {
    const txns = [...history(4, { Food: 10 * K }), txn('2026-10-26', 10 * K)];
    const summary = summarizeBucket(txns, '2026-10-b4', RUB);

    expect(summary.monthToDate).toMatchObject({ throughDay: 31, complete: true });
  });

  it('does not average months before the first record: short history, shorter baseline', () => {
    const txns = [
      txn('2026-07-02', 10 * K),
      txn('2026-08-02', 20 * K),
      txn('2026-09-02', 30 * K),
      txn('2026-10-02', 40 * K),
    ];
    const summary = summarizeBucket(txns, '2026-10-b1', RUB);

    expect(summary.baselineMonths).toBe(3);
    expect(summary.usual).toBe(20 * K);
  });

  it('offers no comparison at all on one earlier month', () => {
    const summary = summarizeBucket(
      [txn('2026-09-02', 10 * K), txn('2026-10-02', 40 * K)],
      '2026-10-b1',
      RUB,
    );

    expect(summary).toMatchObject({ total: 40 * K, usual: null, deltaPct: null });
    expect(summary.above).toEqual([]);
    expect(summary.below).toEqual([]);
    expect(summary.monthToDate).toBeNull();
  });

  it('leaves out incomes, transfers and — unless asked — one-offs', () => {
    const txns = [
      ...history(1, { Food: 10 * K }),
      txn('2026-10-02', 10 * K),
      txn('2026-10-02', 500 * K, 'Income', { type: 'Доход' }),
      txn('2026-10-02', 90 * K, 'Transfer', { type: 'Перевод' }),
      txn('2026-10-03', 30 * K, 'Misc', { oneOff: true }),
    ];

    expect(summarizeBucket(txns, '2026-10-b1', RUB).total).toBe(10 * K);
    expect(summarizeBucket(txns, '2026-10-b1', { money: 'rub', oneOff: true }).total).toBe(40 * K);
  });

  it('adds up the currency it is asked for', () => {
    const txns = [...history(1, { Food: 10 * K }), txn('2026-10-02', 20 * K)];

    const usd = summarizeBucket(txns, '2026-10-b1', { money: 'usd', oneOff: false });
    expect(usd.total).toBe(200);
    expect(usd.usual).toBe(100);
    expect(usd.money).toBe('usd');
  });

  it('copes with a bucket where nothing was spent', () => {
    const summary = summarizeBucket(history(1, { Food: 10 * K }), '2026-10-b1', RUB);

    expect(summary.total).toBe(0);
    expect(summary.deltaPct).toBe(-100);
    expect(summary.below.map((s) => s.category)).toEqual(['Food']);
    expect(summary.above).toEqual([]);
  });
});

describe('recapCaption', () => {
  const summary: BucketSummary = {
    key: '2026-10-b1',
    money: 'rub',
    total: 33_843,
    usual: 53_887,
    deltaPct: -37.2,
    baselineMonths: 6,
    above: [{ category: 'Food', actual: 30_000, usual: 20_592, delta: 9_408 }],
    below: [{ category: 'Education', actual: 0, usual: 4_650, delta: -4_650 }],
    monthToDate: null,
  };

  it('reads like the approved sketch', () => {
    expect(recapCaption(summary, 'RUB')).toBe(
      [
        '🗓 Итоги 1–8 октября: 33 843 ₽ · обычно 53 887 ₽ (−37%)',
        'Больше обычного: Еда +9 408 ₽',
        'Меньше: Обучение −4 650 ₽',
      ].join('\n'),
    );
  });

  it('adds the month so far from the second bucket on', () => {
    const second: BucketSummary = {
      ...summary,
      key: '2026-10-b2',
      monthToDate: {
        month: '2026-10',
        spent: 87_000,
        usual: 101_000,
        deltaPct: -13.9,
        throughDay: 16,
        complete: false,
      },
    };

    const lines = recapCaption(second, 'RUB').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('9–16 октября');
    expect(lines[3]).toBe('Октябрь пока: 87 000 ₽ · обычно к 16-му 101 000 ₽ (−14%)');
  });

  it('calls a finished month finished', () => {
    const last: BucketSummary = {
      ...summary,
      key: '2026-09-b4',
      monthToDate: {
        month: '2026-09',
        spent: 457_171,
        usual: 382_231,
        deltaPct: 19.6,
        throughDay: 30,
        complete: true,
      },
    };

    expect(recapCaption(last, 'RUB').split('\n').at(-1)).toBe(
      'Сентябрь в целом: 457 171 ₽ · обычно 382 231 ₽ (+20%)',
    );
  });

  it('writes dollars as dollars', () => {
    const usd = { ...summary, money: 'usd' as const, total: 812, usual: 640, deltaPct: 26.9 };
    const lines = recapCaption(
      { ...usd, above: [{ category: 'Food', actual: 300, usual: 180, delta: 120 }], below: [] },
      'USD',
    ).split('\n');

    expect(lines[0]).toBe('🗓 Итоги 1–8 октября: $812 · обычно $640 (+27%)');
    expect(lines[1]).toBe('Больше обычного: Еда +$120');
  });

  it('is just the headline when there is nothing to compare with', () => {
    expect(
      recapCaption({ ...summary, usual: null, deltaPct: null, above: [], below: [] }, 'RUB'),
    ).toBe('🗓 Итоги 1–8 октября: 33 843 ₽');
  });

  it('escapes names, and a lone zero percent is 0%', () => {
    const odd = recapCaption(
      {
        ...summary,
        deltaPct: 0.2,
        above: [{ category: 'R&D <i>', actual: 2, usual: 1, delta: 1 }],
        below: [],
      },
      'RUB',
    );

    expect(odd).toContain('R&amp;D &lt;i&gt; +1 ₽');
    expect(odd).toContain('(0%)');
    expect(odd).not.toContain('<i>');
  });

  it('stays inside a photo caption: 1024 characters, whole lines only', () => {
    const long = 'Ж'.repeat(400);
    const caption = recapCaption(
      {
        ...summary,
        above: [
          { category: long, actual: 2, usual: 1, delta: 1 },
          { category: `${long}2`, actual: 2, usual: 1, delta: 1 },
        ],
        below: [{ category: long, actual: 0, usual: 1, delta: -1 }],
        monthToDate: {
          month: '2026-10',
          spent: 1,
          usual: 2,
          deltaPct: -50,
          throughDay: 16,
          complete: false,
        },
      },
      'RUB',
    );

    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption.startsWith('🗓 Итоги 1–8 октября')).toBe(true);
    expect(caption.split('\n').every((line) => line.length > 0)).toBe(true);
  });

  it('is short with ordinary names', () => {
    expect(recapCaption(summary, 'RUB').length).toBeLessThan(300);
  });
});

describe('recap state', () => {
  function statePath(): string {
    return join(mkdtempSync(join(tmpdir(), 'budget-bot-')), 'recap.json');
  }

  it('starts empty', () => {
    expect(createRecapStore(statePath()).get()).toEqual({
      lastSent: null,
      sentAt: null,
      messageId: null,
    });
  });

  it('survives a restart as plain JSON', () => {
    const path = statePath();
    const saved = { lastSent: '2026-10-b1', sentAt: '2026-10-09T07:00:00.000Z', messageId: 812 };
    createRecapStore(path).save(saved);

    expect(createRecapStore(path).get()).toEqual(saved);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(saved);
  });

  it('starts empty from a broken or half-valid file, not with an exception', () => {
    const broken = statePath();
    writeFileSync(broken, '{ not json');
    expect(createRecapStore(broken).get().lastSent).toBeNull();

    const odd = statePath();
    writeFileSync(odd, JSON.stringify({ lastSent: 5, sentAt: 'x', messageId: 'y' }));
    expect(createRecapStore(odd).get()).toEqual({ lastSent: null, sentAt: 'x', messageId: null });
  });
});

describe('buttons of the picture', () => {
  const CATEGORIES = Array.from({ length: 16 }, (_, i) => `Category ${i + 1}`);
  const worst: ReportState = {
    period: 'bucket',
    count: 24,
    categories: CATEGORIES,
    oneOff: true,
    currency: 'RUB',
  };

  function callbacks(state: ReportState, keyboard = photoKeyboard) {
    return keyboard(state, CATEGORIES)
      .inline_keyboard.flat()
      .map((button) => ('callback_data' in button ? button.callback_data : ''));
  }

  it('keeps every callback inside 64 bytes and decodable, in both modes and the worst case', () => {
    for (const state of [
      DEFAULT_REPORT,
      worst,
      { ...worst, period: 'month' as const, count: 24 },
    ]) {
      for (const data of callbacks(state)) {
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
        expect(decodeReport(data, CATEGORIES)).not.toBeNull();
      }
    }
  });

  it('redraws the picture with every button but the table one', () => {
    const buttons = photoKeyboard(DEFAULT_REPORT, CATEGORIES).inline_keyboard.flat();
    const table = buttons.filter((b) => 'callback_data' in b && b.callback_data.startsWith('r:'));
    const picture = buttons.filter(
      (b) => 'callback_data' in b && b.callback_data.startsWith('ri:'),
    );

    expect(table.map((b) => b.text)).toEqual(['📊 Таблица']);
    expect(picture.length).toBe(buttons.length - 1);
    // The table button keeps the whole screen state
    expect(decodeReport(callbacks(DEFAULT_REPORT).at(-1)!, CATEGORIES)).toEqual(DEFAULT_REPORT);
  });

  it('shows bucket windows as months and flips currency and one-offs', () => {
    const buttons = photoKeyboard(DEFAULT_REPORT, CATEGORIES).inline_keyboard.flat();
    const labels = buttons.map((b) => b.text);

    expect(labels).toEqual(
      expect.arrayContaining(['1 мес', '• 2 мес', '3 мес', '6 мес', '• Недели', 'Месяцы']),
    );
    expect(labels).toEqual(expect.arrayContaining(['USD ⇄ RUB', '± разовые']));

    const state = (label: string) => {
      const button = buttons.find((b) => b.text === label);
      return decodeReport('callback_data' in button! ? button.callback_data : '', CATEGORIES);
    };
    expect(state('USD ⇄ RUB')).toEqual({ ...DEFAULT_REPORT, currency: 'USD' });
    expect(state('± разовые')).toEqual({ ...DEFAULT_REPORT, oneOff: true });
    expect(state('6 мес')).toEqual({ ...DEFAULT_REPORT, count: 24 });
  });

  it('puts a «🖼 Картинка» button on the plain /report screen', () => {
    const image = reportKeyboard(DEFAULT_REPORT, CATEGORIES)
      .inline_keyboard.flat()
      .find((button) => button.text === '🖼 Картинка');

    expect(image && 'callback_data' in image && image.callback_data).toBe('ri:b8:-:r');
  });
});

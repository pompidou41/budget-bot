import { describe, expect, it } from 'vitest';
import { renderCapital, renderCapitalCaption } from '../src/domain/capital.js';
import { buildCapitalModel } from '../src/domain/capital-model.js';
import { labelIndices, renderCapitalSvg } from '../src/render/capital-svg.js';
import { parseCapital } from '../src/sheets/capital-read.js';

const pad = (row: unknown[], n = 14) => [...row, ...new Array<string>(n - row.length).fill('')];
const header = [
  'Дата',
  'Капитал, USD',
  'Δ',
  'Сбережения, USD',
  'Δ',
  'Текущие',
  'Ежемесячные',
  'Подушка',
  'Накопления',
  'Инвестиции',
  'Крипта',
  'Расчёты',
  'Кредиты',
  'Закрытые',
];

function sheet(): unknown[][] {
  const rows: unknown[][] = Array.from({ length: 23 }, () => pad([]));
  rows[0] = pad(['', '', 'по текущим курсам (лист Курсы)']);
  rows[1] = pad(['', 'USD']);
  rows[2] = pad(['', 'Недели']);
  rows[3] = pad(['', 'Сейчас, USD', 'За месяц (с 25.10)', '%', 'С 01.09.26', '%']);
  rows[4] = pad(['Капитал', 10234.4, -910.2, -0.0817, 500, 0.05]);
  rows[5] = pad(['Сбережения', 8000, 1.2, 0.0001, 300, 0.04]);
  rows.push(header);
  rows.push(pad(['01.09.26', 9734, '', 5000, '', 100, 0, 0, 0, 0, 0, 0, 0, -5.68e-14]));
  rows.push(pad(['сейчас', 10234.4, -5.68e-14, 8000, 120, 2000, 0, 3000, 0, 4000.4, 0, 0, -10, 0]));
  return rows;
}

describe('capital', () => {
  it('parses the sheet: noise to zero, empty Δ to null, groups from the header', () => {
    const s = parseCapital(sheet())!;
    expect(s.currency).toBe('USD');
    expect(s.points).toHaveLength(2);
    expect(s.points[0]!.capitalDelta).toBeNull();
    expect(s.points[1]!.capitalDelta).toBe(0);
    expect(s.capital.monthPct).toBe(-0.0817);
    expect(s.groups.filter((g) => g.value !== 0).map((g) => g.name)).toEqual([
      'Текущие',
      'Подушка',
      'Инвестиции',
      'Кредиты',
    ]);
  });

  it('is null when the sheet is empty', () => {
    expect(parseCapital([])).toBeNull();
    expect(parseCapital(sheet().slice(0, 24))).toBeNull();
  });

  it('renders the text fallback and the caption', () => {
    const s = parseCapital(sheet())!;
    const out = renderCapital(s);
    for (const part of ['$10', '910', '8,2%', 'по текущим курсам']) expect(out).toContain(part);
    expect(out).not.toContain('<pre>');
    expect(out).not.toContain('Закрытые:');
    const caption = renderCapitalCaption(s).replace(/[\u202f\u00a0]/g, ' ');
    expect(caption).toContain('$10 234');
    expect(caption).toContain('за месяц');
    expect(caption.length).toBeLessThan(1024);
  });

  describe('picture', () => {
    const flat = (svg: string) => svg.replace(/[\u202f\u00a0]/g, ' ');
    const points = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        label: i === n - 1 ? 'сейчас' : `${String((i % 28) + 1).padStart(2, '0')}.09.26`,
        capital: 10000 + i * 37,
        capitalDelta: null,
        savings: 8000 + i * 20,
        savingsDelta: null,
      }));
    const withPoints = (n: number, currency = 'USD') => ({
      ...parseCapital(sheet())!,
      currency,
      points: points(n),
    });

    it('draws the numbers of the sample, without NaN', () => {
      const svg = flat(renderCapitalSvg(buildCapitalModel(parseCapital(sheet())!)));
      for (const part of ['$10 234', '$8 000', '−8,2%', 'Сейчас по группам', 'Подушка']) {
        expect(svg).toContain(part);
      }
      expect(svg).not.toContain('NaN');
    });

    it('survives one point and thins labels for sixty', () => {
      expect(renderCapitalSvg(buildCapitalModel(withPoints(1)))).not.toContain('NaN');
      const model = buildCapitalModel(withPoints(60));
      expect(model.points).toHaveLength(26);
      const svg = renderCapitalSvg(model);
      expect(svg).toContain('последние 26 срезов');
      const idx = labelIndices(26, 30);
      expect(idx.length).toBeLessThanOrEqual(14);
      expect(idx[0]).toBe(0);
      expect(idx[idx.length - 1]).toBe(25);
    });

    it('writes rubles with the mark', () => {
      const svg = flat(renderCapitalSvg(buildCapitalModel(withPoints(3, 'RUB'))));
      expect(svg).toContain('10 234 ₽');
      expect(svg).toMatch(/\d тыс ₽/);
    });
  });
});

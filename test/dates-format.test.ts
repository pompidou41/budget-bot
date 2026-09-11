import { describe, expect, it } from 'vitest';
import {
  addDays,
  isIsoDate,
  parseUserDate,
  serialToIso,
  todayIn,
  weekday,
} from '../src/domain/dates.js';
import { formatUsd, parseAmount } from '../src/domain/format.js';
import { TZ } from './fixtures.js';

describe('todayIn', () => {
  it('uses the configured time zone, not UTC', () => {
    expect(todayIn(TZ, new Date('2026-09-10T21:30:00Z'))).toBe('2026-09-11');
    expect(todayIn(TZ, new Date('2026-09-10T20:59:00Z'))).toBe('2026-09-10');
  });
});

describe('date helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('validates real calendar dates', () => {
    expect(isIsoDate('2026-09-11')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('11.09.2026')).toBe(false);
  });

  it('converts Sheets serial numbers', () => {
    expect(serialToIso(45658)).toBe('2025-01-01');
    expect(serialToIso(45658.75)).toBe('2025-01-01');
  });

  it('knows the weekday', () => {
    expect(weekday('2026-09-11')).toBe('пт');
  });
});

describe('parseUserDate', () => {
  const today = '2026-09-11';

  it.each([
    ['вчера', '2026-09-10'],
    ['позавчера', '2026-09-09'],
    ['2026-09-05', '2026-09-05'],
    ['05.09.2026', '2026-09-05'],
    ['5.9.26', '2026-09-05'],
    ['05.09', '2026-09-05'],
    ['5/9', '2026-09-05'],
  ])('%s → %s', (input, expected) => {
    expect(parseUserDate(input, today)).toBe(expected);
  });

  it.each(['31.02', 'abc', '2026-13-01', ''])('rejects %s', (input) => {
    expect(parseUserDate(input, today)).toBeNull();
  });
});

describe('parseAmount', () => {
  it.each([
    ['1500', 1500],
    ['1 500,50', 1500.5],
    ['1.5к', 1500],
    ['2k', 2000],
    ['3 тыс', 3000],
    ['0.00012', 0.00012],
  ])('%s → %d', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(['0', '-5', 'abc', '', '1.2.3'])('rejects %s', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('rounds to cents and keeps the sign', () => {
    expect(formatUsd(3.456)).toBe('$3,46');
    expect(formatUsd(-12)).toBe('−$12');
  });
});

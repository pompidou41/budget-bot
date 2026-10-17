import { describe, expect, it } from 'vitest';
import {
  addDays,
  isIsoDate,
  nowSerialIn,
  parseUserDate,
  serialToIso,
  todayIn,
  weekday,
} from '../src/domain/dates.js';
import { formatMoney, formatUsd, parseAmount } from '../src/domain/format.js';
import { TZ } from './fixtures.js';

describe('todayIn', () => {
  it('uses the configured time zone, not UTC', () => {
    expect(todayIn(TZ, new Date('2026-09-10T21:30:00Z'))).toBe('2026-09-11');
    expect(todayIn(TZ, new Date('2026-09-10T20:59:00Z'))).toBe('2026-09-10');
  });
});

describe('nowSerialIn', () => {
  it('is the local wall-clock time as a Sheets serial, whole seconds', () => {
    // 2026-10-19 14:05:33 in Moscow (UTC+3); 2026-10-19 is serial 46314
    const serial = nowSerialIn(TZ, new Date('2026-10-19T11:05:33.700Z'));
    expect(serialToIso(serial)).toBe('2026-10-19');
    expect(Math.round(serial * 86_400)).toBe(46314 * 86_400 + 14 * 3600 + 5 * 60 + 33);
  });

  it('rolls over to the next local day before UTC does', () => {
    expect(serialToIso(nowSerialIn(TZ, new Date('2026-10-19T21:30:00Z')))).toBe('2026-10-20');
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

describe('formatMoney', () => {
  it('writes dollars the way formatUsd does', () => {
    expect(formatMoney(3.456, 'USD')).toBe(formatUsd(3.456));
    expect(formatMoney(-12, 'USD')).toBe('−$12');
  });

  it('writes whole rubles joined to the ₽ by a non-breaking space', () => {
    expect(formatMoney(12340, 'RUB')).toBe('12\u00a0340\u00a0₽');
    expect(formatMoney(12339.6, 'RUB')).toBe('12\u00a0340\u00a0₽');
    expect(formatMoney(950, 'RUB')).toBe('950\u00a0₽');
    expect(formatMoney(-1500, 'RUB')).toBe('−1\u00a0500\u00a0₽');
  });

  it('does not sign a ruble amount that rounds to nothing', () => {
    expect(formatMoney(-0.2, 'RUB')).toBe('0\u00a0₽');
  });
});

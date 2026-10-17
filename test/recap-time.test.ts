import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedToUtc } from '../src/domain/dates.js';
import { logger } from '../src/logger.js';
import { createRecapScheduler, dueRecap, nextFireAt } from '../src/scheduler/recap.js';
import type { RecapState, RecapStore } from '../src/state/recap.js';
import { TZ } from './fixtures.js';

const iso = (date: Date) => date.toISOString();

describe('zonedToUtc', () => {
  it('reads the clock of the zone: Moscow is UTC+3 all year', () => {
    expect(iso(zonedToUtc('2026-10-09', 10, 'Europe/Moscow'))).toBe('2026-10-09T07:00:00.000Z');
    expect(iso(zonedToUtc('2026-01-09', 10, 'Europe/Moscow'))).toBe('2026-01-09T07:00:00.000Z');
  });

  it('follows daylight saving: Berlin on both sides of 25 October 2026', () => {
    // Clocks go back at 03:00 that night, so the 24th is still summer time
    expect(iso(zonedToUtc('2026-10-24', 10, 'Europe/Berlin'))).toBe('2026-10-24T08:00:00.000Z');
    expect(iso(zonedToUtc('2026-10-25', 10, 'Europe/Berlin'))).toBe('2026-10-25T09:00:00.000Z');
    expect(iso(zonedToUtc('2027-03-27', 10, 'Europe/Berlin'))).toBe('2027-03-27T09:00:00.000Z');
    expect(iso(zonedToUtc('2027-03-28', 10, 'Europe/Berlin'))).toBe('2027-03-28T08:00:00.000Z');
  });

  it('follows daylight saving in the Americas too', () => {
    expect(iso(zonedToUtc('2026-10-31', 10, 'America/New_York'))).toBe('2026-10-31T14:00:00.000Z');
    expect(iso(zonedToUtc('2026-11-01', 10, 'America/New_York'))).toBe('2026-11-01T15:00:00.000Z');
    expect(iso(zonedToUtc('2027-03-14', 10, 'America/New_York'))).toBe('2027-03-14T14:00:00.000Z');
  });

  it('handles zones with no daylight saving and zones ahead of the date line', () => {
    expect(iso(zonedToUtc('2026-10-09', 10, 'Asia/Yekaterinburg'))).toBe(
      '2026-10-09T05:00:00.000Z',
    );
    // New Zealand is on summer time (+13) in October: 10:00 there is the evening before in UTC
    expect(iso(zonedToUtc('2026-10-09', 10, 'Pacific/Auckland'))).toBe('2026-10-08T21:00:00.000Z');
  });

  it('lands on the hour it was asked for, in the zone, for every day of a DST year', () => {
    const wall = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (let day = 0; day < 365; day++) {
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      expect(wall.format(zonedToUtc(date, 10, 'Europe/Berlin'))).toBe('10:00');
    }
  });
});

describe('nextFireAt', () => {
  it('is 10:00 on the 9th, strictly after a moment one second earlier', () => {
    // 09:59:59 in Moscow
    expect(iso(nextFireAt(new Date('2026-10-09T06:59:59Z'), TZ))).toBe('2026-10-09T07:00:00.000Z');
  });

  it('is the next one, not this one, at the very moment of 10:00:00', () => {
    expect(iso(nextFireAt(new Date('2026-10-09T07:00:00.000Z'), TZ))).toBe(
      '2026-10-17T07:00:00.000Z',
    );
    expect(iso(nextFireAt(new Date('2026-10-09T07:00:00.001Z'), TZ))).toBe(
      '2026-10-17T07:00:00.000Z',
    );
  });

  it('goes 1st, 9th, 17th, 25th and on to the 1st of the next month', () => {
    const fires: string[] = [];
    let now = new Date('2026-10-01T07:00:00Z');
    for (let i = 0; i < 5; i++) {
      now = nextFireAt(now, TZ);
      fires.push(iso(now));
    }
    expect(fires).toEqual([
      '2026-10-09T07:00:00.000Z',
      '2026-10-17T07:00:00.000Z',
      '2026-10-25T07:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-09T07:00:00.000Z',
    ]);
  });

  it('rolls the year over from 25 December to 1 January', () => {
    expect(iso(nextFireAt(new Date('2026-12-25T08:00:00Z'), TZ))).toBe('2027-01-01T07:00:00.000Z');
  });

  it('uses the local date, not the UTC one', () => {
    // 01:00 on the 9th in Moscow is still the 8th in UTC
    expect(iso(nextFireAt(new Date('2026-10-08T22:00:00Z'), TZ))).toBe('2026-10-09T07:00:00.000Z');
    // 12:30 on 1 November in Auckland is still 31 October in UTC
    expect(iso(nextFireAt(new Date('2026-10-31T23:30:00Z'), 'Pacific/Auckland'))).toBe(
      '2026-11-08T21:00:00.000Z',
    );
  });

  it('keeps 10:00 local across the Berlin clock change', () => {
    // The 25th is the day the clocks go back; its 10:00 is already winter time
    expect(iso(nextFireAt(new Date('2026-10-17T12:00:00Z'), 'Europe/Berlin'))).toBe(
      '2026-10-25T09:00:00.000Z',
    );
    expect(iso(nextFireAt(new Date('2026-10-25T09:00:00Z'), 'Europe/Berlin'))).toBe(
      '2026-11-01T09:00:00.000Z',
    );
  });

  it('works in New York and Yekaterinburg', () => {
    expect(iso(nextFireAt(new Date('2026-10-26T00:00:00Z'), 'America/New_York'))).toBe(
      '2026-11-01T15:00:00.000Z',
    );
    expect(iso(nextFireAt(new Date('2026-10-08T00:00:00Z'), 'Asia/Yekaterinburg'))).toBe(
      '2026-10-09T05:00:00.000Z',
    );
  });

  it('honours another hour', () => {
    expect(iso(nextFireAt(new Date('2026-10-09T00:00:00Z'), TZ, 8))).toBe(
      '2026-10-09T05:00:00.000Z',
    );
  });
});

describe('dueRecap', () => {
  it('opens at 10:00:00 and not a second before', () => {
    expect(dueRecap(new Date('2026-10-09T06:59:59Z'), TZ, null)).toBeNull();
    expect(dueRecap(new Date('2026-10-09T07:00:00Z'), TZ, null)).toBe('2026-10-b1');
  });

  it('names the bucket that has just closed on each of the four days', () => {
    expect(dueRecap(new Date('2026-10-09T07:00:00Z'), TZ, null)).toBe('2026-10-b1');
    expect(dueRecap(new Date('2026-10-17T07:00:00Z'), TZ, null)).toBe('2026-10-b2');
    expect(dueRecap(new Date('2026-10-25T07:00:00Z'), TZ, null)).toBe('2026-10-b3');
    expect(dueRecap(new Date('2026-11-01T07:00:00Z'), TZ, null)).toBe('2026-10-b4');
  });

  it('reaches back across the month and the year', () => {
    expect(dueRecap(new Date('2027-01-01T07:00:00Z'), TZ, null)).toBe('2026-12-b4');
    // February is short: its last bucket is 25–28
    expect(dueRecap(new Date('2027-03-01T07:00:00Z'), TZ, null)).toBe('2027-02-b4');
  });

  it('stays open for 24 hours, so a late start or an outage still delivers it', () => {
    expect(dueRecap(new Date('2026-10-09T20:59:00Z'), TZ, null)).toBe('2026-10-b1');
    // 09:59:59 on the 10th
    expect(dueRecap(new Date('2026-10-10T06:59:59Z'), TZ, null)).toBe('2026-10-b1');
    expect(dueRecap(new Date('2026-10-10T07:00:00Z'), TZ, null)).toBeNull();
  });

  it('is nothing on an ordinary day', () => {
    expect(dueRecap(new Date('2026-10-13T07:00:00Z'), TZ, null)).toBeNull();
    expect(dueRecap(new Date('2026-10-08T12:00:00Z'), TZ, null)).toBeNull();
  });

  it('is nothing once that bucket has been sent', () => {
    expect(dueRecap(new Date('2026-10-09T08:00:00Z'), TZ, '2026-10-b1')).toBeNull();
    // An older recap does not stand in for this one
    expect(dueRecap(new Date('2026-10-09T08:00:00Z'), TZ, '2026-09-b4')).toBe('2026-10-b1');
  });

  it('follows the clock of the zone, daylight saving included', () => {
    // 25 October 2026 in Berlin: 10:00 is 09:00 UTC
    expect(dueRecap(new Date('2026-10-25T08:59:59Z'), 'Europe/Berlin', null)).toBeNull();
    expect(dueRecap(new Date('2026-10-25T09:00:00Z'), 'Europe/Berlin', null)).toBe('2026-10-b3');
    expect(dueRecap(new Date('2026-10-09T05:00:00Z'), 'Asia/Yekaterinburg', null)).toBe(
      '2026-10-b1',
    );
    expect(dueRecap(new Date('2026-11-01T15:00:00Z'), 'America/New_York', null)).toBe('2026-10-b4');
  });
});

describe('createRecapScheduler', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  function memoryState(initial: Partial<RecapState> = {}) {
    let state: RecapState = { lastSent: null, sentAt: null, messageId: null, ...initial };
    const save = vi.fn((next: RecapState) => {
      state = next;
    });
    const store: RecapStore = { get: () => state, save };
    return { store, save, current: () => state };
  }

  function setup(
    options: {
      state?: Partial<RecapState>;
      enabled?: () => boolean;
      send?: (key: string) => Promise<number>;
    } = {},
  ) {
    const state = memoryState(options.state);
    const send = vi.fn(options.send ?? (() => Promise.resolve(42)));
    const scheduler = createRecapScheduler({
      now: () => new Date(),
      timeZone: TZ,
      state: state.store,
      enabled: options.enabled ?? (() => true),
      send,
    });
    return { ...state, send, scheduler };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the recap once, at 10:00, and records it', async () => {
    vi.setSystemTime(new Date('2026-10-09T06:30:00Z'));
    const { scheduler, send, current } = setup();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('2026-10-b1');
    expect(current()).toMatchObject({ lastSent: '2026-10-b1', messageId: 42 });
    expect(current().sentAt).toBe('2026-10-09T07:00:00.000Z');

    // The rest of the day, the night, the next three days: nothing more
    await vi.advanceTimersByTimeAsync(4 * 24 * HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('goes on to the next recap when the days come', async () => {
    vi.setSystemTime(new Date('2026-10-09T06:30:00Z'));
    const { scheduler, send } = setup();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(9 * 24 * HOUR);

    expect(send.mock.calls.map(([key]) => key)).toEqual(['2026-10-b1', '2026-10-b2']);
    scheduler.stop();
  });

  it('sends at once on start when it is already inside the window and nothing was sent', async () => {
    vi.setSystemTime(new Date('2026-10-09T09:00:00Z'));
    const { scheduler, send } = setup();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('sends nothing after a restart when the recap is already on record', async () => {
    vi.setSystemTime(new Date('2026-10-09T09:00:00Z'));
    const { scheduler, send, save } = setup({
      state: { lastSent: '2026-10-b1', sentAt: '2026-10-09T07:00:00.000Z', messageId: 7 },
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(20 * HOUR);
    expect(send).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('tries again in 15 minutes after a failure, and records only the success', async () => {
    vi.setSystemTime(new Date('2026-10-09T07:00:00Z'));
    const attempts: string[] = [];
    const { scheduler, send, save, current } = setup({
      send: () => {
        attempts.push(new Date().toISOString());
        return attempts.length === 1
          ? Promise.reject(new Error('Telegram is down'))
          : Promise.resolve(9);
      },
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(send).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(['2026-10-09T07:00:00.000Z', '2026-10-09T07:15:00.000Z']);
    expect(current()).toMatchObject({ lastSent: '2026-10-b1', messageId: 9 });

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(send).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('gives up when the 24 hours are over', async () => {
    vi.setSystemTime(new Date('2026-10-09T07:00:00Z'));
    const times: number[] = [];
    const { scheduler, save } = setup({
      send: () => {
        times.push(Date.now());
        return Promise.reject(new Error('still down'));
      },
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(30 * HOUR);

    expect(times.length).toBeGreaterThan(50);
    expect(Math.max(...times)).toBeLessThan(Date.parse('2026-10-10T07:00:00Z'));
    expect(save).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('does not send twice when only the write to disk failed', async () => {
    vi.setSystemTime(new Date('2026-10-09T07:00:00Z'));
    const { scheduler, send, save } = setup();
    save.mockImplementation(() => {
      throw new Error('disk full');
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('sends nothing while recaps are switched off, and sends when they are back on in time', async () => {
    vi.setSystemTime(new Date('2026-10-09T07:00:00Z'));
    let on = false;
    const { scheduler, send } = setup({ enabled: () => on });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(send).not.toHaveBeenCalled();

    on = true;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(send).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('looks at the clock at least every hour, however far the next recap is', async () => {
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const enabled = vi.fn(() => true);
    const { scheduler } = setup({ enabled });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(enabled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(enabled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(enabled).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('stops: no timer is left and nothing is sent afterwards', async () => {
    vi.setSystemTime(new Date('2026-10-09T06:30:00Z'));
    const { scheduler, send } = setup();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not book another timer if it is stopped while a recap is on its way', async () => {
    vi.setSystemTime(new Date('2026-10-09T07:00:00Z'));
    let finish: (id: number) => void = () => undefined;
    const { scheduler, send } = setup({
      send: () => new Promise<number>((resolve) => (finish = resolve)),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    scheduler.stop();
    finish(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

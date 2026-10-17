import { lastClosedBucket } from '../analytics/buckets.js';
import { shiftMonth } from '../analytics/queries.js';
import { addDays, todayIn, zonedToUtc } from '../domain/dates.js';
import { logger } from '../logger.js';
import type { RecapStore } from '../state/recap.js';

/** The days a bucket closes: after the 8th, 16th and 24th, and at the end of the month. */
export const RECAP_DAYS = [1, 9, 17, 25];
export const RECAP_HOUR = 10;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Longest the timer sleeps: a missed wake-up or a changed clock is noticed within the hour. */
const MAX_SLEEP_MS = HOUR_MS;
const RETRY_MS = 15 * 60 * 1000;

function fireTime(isoDate: string, timeZone: string, hour: number): Date {
  return zonedToUtc(isoDate, hour, timeZone);
}

/** The first recap moment strictly after `now`: 10:00 local time on the 1st, 9th, 17th or 25th. */
export function nextFireAt(now: Date, timeZone: string, hour = RECAP_HOUR): Date {
  const month = todayIn(timeZone, now).slice(0, 7);
  // The rest of this month, then the next one: its 1st always comes after `now`
  for (const candidate of [month, shiftMonth(month, 1)]) {
    for (const day of RECAP_DAYS) {
      const at = fireTime(`${candidate}-${String(day).padStart(2, '0')}`, timeZone, hour);
      if (at.getTime() > now.getTime()) return at;
    }
  }
  throw new Error('unreachable: the 1st of next month is always ahead');
}

/**
 * The bucket whose recap is due at `now`, or null. A recap is due for 24 hours from its fire
 * time, so a restart or a Telegram outage in that stretch still delivers it, and never twice
 * (`lastSent` is the bucket already delivered).
 */
export function dueRecap(
  now: Date,
  timeZone: string,
  lastSent: string | null,
  hour = RECAP_HOUR,
): string | null {
  const today = todayIn(timeZone, now);
  // A window that opened yesterday morning is still open this morning before the hour
  for (const day of [today, addDays(today, -1)]) {
    if (!RECAP_DAYS.includes(Number(day.slice(8)))) continue;
    const opens = fireTime(day, timeZone, hour).getTime();
    if (now.getTime() >= opens && now.getTime() < opens + DAY_MS) {
      const key = lastClosedBucket(day);
      return key === lastSent ? null : key;
    }
  }
  return null;
}

export interface RecapSchedulerOptions {
  now: () => Date;
  timeZone: string;
  state: RecapStore;
  /** Asked on every check, so switching recaps off in /settings takes effect without a restart. */
  enabled: () => boolean;
  /** Sends the recap of a bucket; resolves to the id of the message it sent. */
  send: (key: string) => Promise<number>;
}

export interface RecapScheduler {
  start(): void;
  stop(): void;
}

/**
 * Sends the recap of a closed bucket on the 1st, 9th, 17th and 25th at 10:00. It sleeps in
 * stretches of at most an hour and re-derives from the clock what is due, so it holds no
 * schedule of its own that a restart or a long `setTimeout` could get wrong.
 */
export function createRecapScheduler(options: RecapSchedulerOptions): RecapScheduler {
  const { now, timeZone, state, enabled, send } = options;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  // If the disk refuses the write, the bucket still must not go out again on the next check
  let delivered: string | null = null;

  function sleep(ms: number): void {
    if (stopped) return;
    timer = setTimeout(() => void check(), ms);
  }

  async function check(): Promise<void> {
    timer = undefined;
    if (stopped) return;

    // However this goes, the next check must be booked, or recaps would silently stop for good
    let delay = MAX_SLEEP_MS;
    try {
      const lastSent = delivered ?? state.get().lastSent;
      const key = enabled() ? dueRecap(now(), timeZone, lastSent) : null;
      if (key && !(await trySend(key))) delay = RETRY_MS;
      else delay = Math.min(nextFireAt(now(), timeZone).getTime() - now().getTime(), MAX_SLEEP_MS);
    } catch (error) {
      logger.error({ error }, 'Recap check failed');
    }
    sleep(delay);
  }

  /** false when the send failed and is worth another go. */
  async function trySend(key: string): Promise<boolean> {
    let messageId: number;
    try {
      messageId = await send(key);
    } catch (error) {
      // Still inside the 24 h window, so trying again is cheap and may well work
      logger.error({ error, key }, 'Failed to send recap, will retry');
      return false;
    }

    delivered = key;
    logger.info({ key, messageId }, 'Recap sent');
    try {
      state.save({ lastSent: key, sentAt: now().toISOString(), messageId });
    } catch (error) {
      logger.error({ error, key }, 'Recap was sent but could not be recorded');
    }
    return true;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void check();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

import { describe, it, expect } from 'vitest';
import { US_CALENDAR, IN_CALENDAR, CRYPTO_CALENDAR, zonedParts } from './calendars.js';

// 2026-09-04 is a Friday; 2026-09-05 a Saturday.
const at = (iso: string): Date => new Date(iso);

describe('zonedParts', () => {
  it('reads the weekday and minute in the target zone, not the local one', () => {
    // 13:30 UTC on a Friday is 09:30 in New York and 19:00 in Kolkata.
    expect(zonedParts(at('2026-09-04T13:30:00Z'), 'America/New_York')).toEqual({
      weekday: 5, minutes: 9 * 60 + 30,
    });
    expect(zonedParts(at('2026-09-04T13:30:00Z'), 'Asia/Kolkata')).toEqual({
      weekday: 5, minutes: 19 * 60,
    });
  });

  it('normalises midnight to 0 rather than 24', () => {
    expect(zonedParts(at('2026-09-04T04:00:00Z'), 'America/New_York').minutes).toBe(0);
  });

  it('rolls the weekday over when the zone is a day ahead', () => {
    // Friday 21:00 UTC is Saturday 02:30 in Kolkata.
    expect(zonedParts(at('2026-09-04T21:00:00Z'), 'Asia/Kolkata').weekday).toBe(6);
  });
});

describe('US_CALENDAR', () => {
  it('is open at the opening bell and shut a minute before it', () => {
    expect(US_CALENDAR.isOpen(at('2026-09-04T13:30:00Z'))).toBe(true);
    expect(US_CALENDAR.isOpen(at('2026-09-04T13:29:00Z'))).toBe(false);
  });

  it('is shut at exactly 16:00 — the close is exclusive', () => {
    expect(US_CALENDAR.isOpen(at('2026-09-04T19:59:00Z'))).toBe(true);
    expect(US_CALENDAR.isOpen(at('2026-09-04T20:00:00Z'))).toBe(false);
  });

  it('is shut at the weekend', () => {
    expect(US_CALENDAR.isOpen(at('2026-09-05T15:00:00Z'))).toBe(false);
    expect(US_CALENDAR.isOpen(at('2026-09-06T15:00:00Z'))).toBe(false);
  });
});

describe('IN_CALENDAR', () => {
  it('opens at 09:15 IST and closes at 15:30 IST', () => {
    // 03:45 UTC = 09:15 IST; 10:00 UTC = 15:30 IST.
    expect(IN_CALENDAR.isOpen(at('2026-09-04T03:45:00Z'))).toBe(true);
    expect(IN_CALENDAR.isOpen(at('2026-09-04T03:44:00Z'))).toBe(false);
    expect(IN_CALENDAR.isOpen(at('2026-09-04T09:59:00Z'))).toBe(true);
    expect(IN_CALENDAR.isOpen(at('2026-09-04T10:00:00Z'))).toBe(false);
  });

  it('is shut on a Saturday in Kolkata even while it is Friday in New York', () => {
    // Friday 21:00 UTC: still Friday evening in NY, already Saturday in India.
    expect(IN_CALENDAR.isOpen(at('2026-09-04T21:00:00Z'))).toBe(false);
  });
});

describe('CRYPTO_CALENDAR', () => {
  it('is open at every hour of every day, including Sunday at 03:00', () => {
    for (const iso of [
      '2026-09-06T03:00:00Z', '2026-09-04T13:30:00Z', '2026-01-01T00:00:00Z',
    ]) {
      expect(CRYPTO_CALENDAR.isOpen(at(iso))).toBe(true);
    }
  });
});

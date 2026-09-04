import type { SessionCalendar } from './types.js';

/**
 * Wall-clock time in a named zone.
 *
 * Formatting into the target zone and reading the parts back is deliberate:
 * `new Date(d.toLocaleString('en-US', { timeZone }))` is the common shortcut and
 * it is wrong on any machine whose own locale is not en-US, because it reparses
 * a localised string with the local parser. Intl parts are unambiguous.
 */
export function zonedParts(at: Date, timeZone: string): { weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts['hour'] ?? '0') % 24; // en-US hour12:false can emit 24
  return {
    weekday: days[parts['weekday'] ?? 'Sun'] ?? 0,
    minutes: hour * 60 + Number(parts['minute'] ?? '0'),
  };
}

/**
 * Full-day exchange closures, as ISO dates in the exchange's own timezone.
 *
 * Hand-maintained and therefore finite: these run to the end of 2027 and the
 * calendar says so rather than silently treating an unlisted year as open.
 * Half-days (early closes) are NOT modelled — trading into a 13:00 close is
 * treated as a normal session.
 */
export const US_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

/** NSE/BSE full-day closures. Same caveats as US_HOLIDAYS. */
export const IN_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-26', '2026-03-03', '2026-03-19', '2026-04-03', '2026-04-14',
  '2026-05-01', '2026-08-15', '2026-08-28', '2026-10-02', '2026-10-21',
  '2026-11-09', '2026-12-25',
  // 2027
  '2027-01-26', '2027-03-22', '2027-04-01', '2027-04-14', '2027-05-01',
  '2027-08-15', '2027-10-02', '2027-11-09', '2027-12-25',
]);

/** Last year each holiday list covers. Beyond this the data is absent, not empty. */
export const HOLIDAYS_THROUGH_YEAR = 2027;

/** ISO date (YYYY-MM-DD) in the given zone. */
export function zonedDate(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`;
}

/**
 * True when the date is a known closure.
 *
 * Beyond the maintained range this returns false, which means the calendar will
 * treat an unlisted 2028 holiday as a normal session. `holidaysCoverYear` exists
 * so a caller can warn rather than quietly trading on Christmas Day 2028.
 */
export function isHoliday(at: Date, timeZone: string, holidays: ReadonlySet<string>): boolean {
  return holidays.has(zonedDate(at, timeZone));
}

export function holidaysCoverYear(at: Date, timeZone: string): boolean {
  return Number(zonedDate(at, timeZone).slice(0, 4)) <= HOLIDAYS_THROUGH_YEAR;
}

/** Half-days are not modelled: an early close reads as a full session. */
export const HALF_DAYS_MODELLED = false;

function weekdaySession(
  timeZone: string,
  openMin: number,
  closeMin: number,
  holidays: ReadonlySet<string>,
): SessionCalendar {
  return {
    isOpen(at: Date): boolean {
      const { weekday, minutes } = zonedParts(at, timeZone);
      if (weekday === 0 || weekday === 6) return false;
      if (isHoliday(at, timeZone, holidays)) return false;
      return minutes >= openMin && minutes < closeMin;
    },
  };
}

/** US equities regular session: 09:30–16:00 America/New_York, weekdays. */
export const US_CALENDAR: SessionCalendar = weekdaySession(
  'America/New_York', 9 * 60 + 30, 16 * 60, US_HOLIDAYS,
);

/** NSE/BSE regular session: 09:15–15:30 Asia/Kolkata, weekdays. */
export const IN_CALENDAR: SessionCalendar = weekdaySession(
  'Asia/Kolkata', 9 * 60 + 15, 15 * 60 + 30, IN_HOLIDAYS,
);

/**
 * Crypto never closes.
 *
 * This is not a convenience: it removes the market-hours gate that stops the US
 * pipeline overnight, so every other guard — position caps, the daily loss stop,
 * the kill switch — is the only thing standing between a bad signal at 03:00 and
 * a filled order. Worth remembering when tuning limits for this venue.
 */
export const CRYPTO_CALENDAR: SessionCalendar = { isOpen: () => true };


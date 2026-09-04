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

function weekdaySession(timeZone: string, openMin: number, closeMin: number): SessionCalendar {
  return {
    isOpen(at: Date): boolean {
      const { weekday, minutes } = zonedParts(at, timeZone);
      if (weekday === 0 || weekday === 6) return false;
      return minutes >= openMin && minutes < closeMin;
    },
  };
}

/** US equities regular session: 09:30–16:00 America/New_York, weekdays. */
export const US_CALENDAR: SessionCalendar = weekdaySession('America/New_York', 9 * 60 + 30, 16 * 60);

/** NSE/BSE regular session: 09:15–15:30 Asia/Kolkata, weekdays. */
export const IN_CALENDAR: SessionCalendar = weekdaySession('Asia/Kolkata', 9 * 60 + 15, 15 * 60 + 30);

/**
 * Crypto never closes.
 *
 * This is not a convenience: it removes the market-hours gate that stops the US
 * pipeline overnight, so every other guard — position caps, the daily loss stop,
 * the kill switch — is the only thing standing between a bad signal at 03:00 and
 * a filled order. Worth remembering when tuning limits for this venue.
 */
export const CRYPTO_CALENDAR: SessionCalendar = { isOpen: () => true };

/**
 * Exchange holidays are NOT modelled. A holiday looks like a normal session to
 * this calendar, so the simulator will happily fill an order on a day the real
 * exchange was shut. Paper trading absorbs that; a live adapter must not.
 */
export const HOLIDAYS_MODELLED = false;

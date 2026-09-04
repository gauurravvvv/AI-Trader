import { US_CALENDAR, zonedParts, zonedDate, US_HOLIDAYS } from '@aegis/brokers';

export type SessionState = 'OPEN' | 'PRE_MARKET' | 'AFTER_HOURS' | 'CLOSED' | 'HOLIDAY' | 'WEEKEND';

export interface MarketSession {
  state: SessionState;
  open: boolean;
  /** Short human label for the header chip. */
  label: string;
  /** What happens next, and roughly when. */
  next: string;
  /** Minutes until that change, or null when it cannot be known cheaply. */
  minutesToChange: number | null;
  /** Local exchange time, so the reader can sanity-check the rest. */
  exchangeTime: string;
}

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const PRE_OPEN_MIN = 4 * 60;
const AFTER_CLOSE_MIN = 20 * 60;
const TZ = 'America/New_York';

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Where the US session is right now.
 *
 * Pre-market and after-hours are reported separately from CLOSED even though
 * the system does not trade in them: "the market is shut" and "the market is
 * shut but the tape is moving" are different things to look at on a dashboard,
 * and a price that changed overnight is much less alarming when the page says
 * which one it is.
 */
export function marketSession(at: Date): MarketSession {
  const { weekday, minutes } = zonedParts(at, TZ);
  const exchangeTime = `${hhmm(minutes)} ET`;
  const open = US_CALENDAR.isOpen(at);

  if (weekday === 0 || weekday === 6) {
    return {
      state: 'WEEKEND', open: false, label: 'Weekend',
      next: 'Opens Monday 09:30 ET', minutesToChange: null, exchangeTime,
    };
  }

  if (US_HOLIDAYS.has(zonedDate(at, TZ))) {
    return {
      state: 'HOLIDAY', open: false, label: 'Holiday',
      next: 'Exchange closed all day', minutesToChange: null, exchangeTime,
    };
  }

  if (open) {
    return {
      state: 'OPEN', open: true, label: 'Market open',
      next: `Closes ${hhmm(CLOSE_MIN)} ET`,
      minutesToChange: CLOSE_MIN - minutes, exchangeTime,
    };
  }

  if (minutes >= PRE_OPEN_MIN && minutes < OPEN_MIN) {
    return {
      state: 'PRE_MARKET', open: false, label: 'Pre-market',
      next: `Opens ${hhmm(OPEN_MIN)} ET`,
      minutesToChange: OPEN_MIN - minutes, exchangeTime,
    };
  }

  if (minutes >= CLOSE_MIN && minutes < AFTER_CLOSE_MIN) {
    return {
      state: 'AFTER_HOURS', open: false, label: 'After hours',
      next: `Opens ${hhmm(OPEN_MIN)} ET tomorrow`,
      minutesToChange: null, exchangeTime,
    };
  }

  return {
    state: 'CLOSED', open: false, label: 'Closed',
    next: `Opens ${hhmm(OPEN_MIN)} ET`,
    minutesToChange: minutes < OPEN_MIN ? OPEN_MIN - minutes : null,
    exchangeTime,
  };
}

import { describe, it, expect } from 'vitest';
import { marketSession } from './session.js';

const at = (iso: string): Date => new Date(iso);

describe('marketSession', () => {
  it('is open mid-session on a weekday', () => {
    // 2026-09-04 15:00 UTC = 11:00 ET, a Friday.
    const s = marketSession(at('2026-09-04T15:00:00Z'));
    expect(s.state).toBe('OPEN');
    expect(s.open).toBe(true);
    expect(s.next).toContain('16:00');
    expect(s.minutesToChange).toBe(300);
  });

  it('separates pre-market from plain closed', () => {
    // "Shut" and "shut but the tape is moving" are different things to see on a
    // dashboard, and a price that moved overnight is less alarming when the
    // page says which one it is.
    const s = marketSession(at('2026-09-04T12:00:00Z')); // 08:00 ET
    expect(s.state).toBe('PRE_MARKET');
    expect(s.open).toBe(false);
    expect(s.minutesToChange).toBe(90);
  });

  it('reports after-hours until 20:00 ET', () => {
    expect(marketSession(at('2026-09-04T21:00:00Z')).state).toBe('AFTER_HOURS'); // 17:00 ET
  });

  it('reports plain closed overnight', () => {
    expect(marketSession(at('2026-09-04T05:00:00Z')).state).toBe('CLOSED'); // 01:00 ET
  });

  it('knows a weekend', () => {
    const s = marketSession(at('2026-09-05T15:00:00Z'));
    expect(s.state).toBe('WEEKEND');
    expect(s.next).toContain('Monday');
  });

  it('knows a holiday, and does not call it pre-market', () => {
    // 2026-12-25, 15:00 UTC = 10:00 ET, which would otherwise be mid-session.
    const s = marketSession(at('2026-12-25T15:00:00Z'));
    expect(s.state).toBe('HOLIDAY');
    expect(s.open).toBe(false);
  });

  it('reports the exchange clock, not the local one', () => {
    expect(marketSession(at('2026-09-04T15:00:00Z')).exchangeTime).toBe('11:00 ET');
  });

  it('flips exactly at the bell', () => {
    expect(marketSession(at('2026-09-04T13:29:00Z')).open).toBe(false);
    expect(marketSession(at('2026-09-04T13:30:00Z')).open).toBe(true);
    expect(marketSession(at('2026-09-04T19:59:00Z')).open).toBe(true);
    expect(marketSession(at('2026-09-04T20:00:00Z')).open).toBe(false);
  });
});

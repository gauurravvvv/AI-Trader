import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import {
  evaluateWatch, readConditions, driftConditions, newsConditions,
  newFilingSince, opposingNewsSince, type WatchCondition, type WatchContext,
} from './watch.js';

const ctx = (over: Partial<WatchContext> = {}): WatchContext => ({
  price: '100', heldDays: 1, newFilingSinceEntry: false, opposingNewsMateriality: 0, ...over,
});

describe('evaluateWatch', () => {
  it('reports an intact thesis when nothing fires', () => {
    const r = evaluateWatch(driftConditions('100', 45), ctx());
    expect(r.broken).toBe(false);
    expect(r.detail).toBe('thesis intact');
  });

  it('fires PRICE_BELOW and carries the reason it was written for', () => {
    const c: WatchCondition[] = [{ kind: 'PRICE_BELOW', value: '92', why: 'the drift did not materialise' }];
    const r = evaluateWatch(c, ctx({ price: '91.5' }));
    expect(r.broken).toBe(true);
    expect(r.detail).toContain('the drift did not materialise');
  });

  it('does not fire PRICE_BELOW exactly at the level', () => {
    expect(evaluateWatch([{ kind: 'PRICE_BELOW', value: '92', why: 'x' }], ctx({ price: '92' })).broken).toBe(false);
  });

  it('fires PRICE_ABOVE for a thesis that was bearish', () => {
    const r = evaluateWatch([{ kind: 'PRICE_ABOVE', value: '106', why: 'moved against the story' }], ctx({ price: '107' }));
    expect(r.broken).toBe(true);
  });

  it('fires DAYS_ELAPSED at the limit, not after it', () => {
    const c: WatchCondition[] = [{ kind: 'DAYS_ELAPSED', value: 10, why: 'window closed' }];
    expect(evaluateWatch(c, ctx({ heldDays: 9 })).broken).toBe(false);
    expect(evaluateWatch(c, ctx({ heldDays: 10 })).broken).toBe(true);
  });

  it('fires NEW_FILING — the next report supersedes the surprise', () => {
    const r = evaluateWatch(driftConditions('100', 45), ctx({ newFilingSinceEntry: true }));
    expect(r.broken).toBe(true);
    expect(r.condition!.kind).toBe('NEW_FILING');
  });

  it('fires CONTRADICTING_NEWS only above the materiality it was given', () => {
    const c: WatchCondition[] = [{ kind: 'CONTRADICTING_NEWS', minMateriality: 70, why: 'falsified' }];
    expect(evaluateWatch(c, ctx({ opposingNewsMateriality: 65 })).broken).toBe(false);
    expect(evaluateWatch(c, ctx({ opposingNewsMateriality: 70 })).broken).toBe(true);
  });

  it('returns the first condition that fires, in written order', () => {
    const r = evaluateWatch(driftConditions('100', 45), ctx({
      newFilingSinceEntry: true, opposingNewsMateriality: 90, price: '50', heldDays: 99,
    }));
    expect(r.condition!.kind).toBe('NEW_FILING');
  });

  it('treats an empty condition list as nothing to check', () => {
    expect(evaluateWatch([], ctx({ price: '1' })).broken).toBe(false);
  });
});

describe('readConditions', () => {
  it('round-trips structured conditions', () => {
    const written = JSON.stringify(driftConditions('100', 45));
    const { conditions, unevaluable } = readConditions(written);
    expect(conditions).toHaveLength(4);
    expect(unevaluable).toBe(0);
  });

  it('counts legacy prose clauses as unevaluable rather than as absent', () => {
    // Positions opened before conditions were structured hold sentences. A
    // thesis nobody can check is a different thing from nothing to check.
    const legacy = JSON.stringify([
      'guidance is lowered or withdrawn at the next report',
      'price closes below the entry stop',
    ]);
    const { conditions, unevaluable } = readConditions(legacy);
    expect(conditions).toHaveLength(0);
    expect(unevaluable).toBe(2);
  });

  it('keeps the good conditions from a partly-legacy row', () => {
    const mixed = JSON.stringify(['some prose', { kind: 'DAYS_ELAPSED', value: 5, why: 'x' }]);
    const { conditions, unevaluable } = readConditions(mixed);
    expect(conditions).toHaveLength(1);
    expect(unevaluable).toBe(1);
  });

  it('survives null, empty, and malformed JSON', () => {
    for (const raw of [null, '', 'not json', '{"not":"an array"}']) {
      expect(readConditions(raw).conditions).toEqual([]);
    }
  });
});

describe('condition builders', () => {
  it('sets the drift stop 8% below entry and the window at the time stop', () => {
    const c = driftConditions('200', 45);
    expect(c.find((x) => x.kind === 'PRICE_BELOW')).toMatchObject({ value: '184.00' });
    expect(c.find((x) => x.kind === 'DAYS_ELAPSED')).toMatchObject({ value: 45 });
  });

  it('flips the price condition for a bearish news thesis', () => {
    expect(newsConditions('100', 0.9).some((c) => c.kind === 'PRICE_BELOW')).toBe(true);
    expect(newsConditions('100', -0.9).some((c) => c.kind === 'PRICE_ABOVE')).toBe(true);
  });

  it('gives a news thesis a much shorter fuse than a drift thesis', () => {
    const news = newsConditions('100', 1).find((c) => c.kind === 'DAYS_ELAPSED');
    const drift = driftConditions('100', 45).find((c) => c.kind === 'DAYS_ELAPSED');
    expect((news as { value: number }).value).toBeLessThan((drift as { value: number }).value);
  });
});

// ── Against the signal bus ──────────────────────────────────────────────────

let db: Db;
const ENTRY = '2026-09-01T00:00:00Z';

function signal(type: string, symbol: string, at: string, data: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO agent_signals (agent, signal_type, symbol, data, created_at) VALUES ('t',?,?,?,?)`,
  ).run(type, symbol, JSON.stringify(data), at);
}

beforeEach(() => { db = openDb(':memory:'); });

describe('newFilingSince', () => {
  it('sees a filing that landed after entry', () => {
    signal('filing_8k', 'NVDA', '2026-09-03T00:00:00Z');
    expect(newFilingSince(db, 'NVDA', ENTRY)).toBe(true);
  });

  it('ignores the filing that opened the position', () => {
    signal('filing_8k', 'NVDA', '2026-08-30T00:00:00Z');
    expect(newFilingSince(db, 'NVDA', ENTRY)).toBe(false);
  });

  it('does not confuse another symbol', () => {
    signal('filing_8k', 'AMD', '2026-09-03T00:00:00Z');
    expect(newFilingSince(db, 'NVDA', ENTRY)).toBe(false);
  });
});

describe('opposingNewsSince', () => {
  it('reports the strongest opposing story for a long', () => {
    signal('news_signal', 'NVDA', '2026-09-02T00:00:00Z', { direction: -0.8, materiality: 60 });
    signal('news_signal', 'NVDA', '2026-09-03T00:00:00Z', { direction: -0.9, materiality: 85 });
    expect(opposingNewsSince(db, 'NVDA', ENTRY, 'long')).toBe(85);
  });

  it('ignores news that agrees with us, however loud', () => {
    signal('news_signal', 'NVDA', '2026-09-02T00:00:00Z', { direction: 0.95, materiality: 99 });
    expect(opposingNewsSince(db, 'NVDA', ENTRY, 'long')).toBe(0);
  });

  it('flips which side counts as opposing for a short', () => {
    signal('news_signal', 'NVDA', '2026-09-02T00:00:00Z', { direction: 0.9, materiality: 80 });
    expect(opposingNewsSince(db, 'NVDA', ENTRY, 'short')).toBe(80);
    expect(opposingNewsSince(db, 'NVDA', ENTRY, 'long')).toBe(0);
  });

  it('treats a malformed payload as no evidence', () => {
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, data, created_at) VALUES ('t','news_signal','NVDA','{bad',?)`,
    ).run('2026-09-02T00:00:00Z');
    expect(opposingNewsSince(db, 'NVDA', ENTRY, 'long')).toBe(0);
  });
});

describe('timestamp formats', () => {
  it('compares SQLite datetime rows against JavaScript ISO stamps', () => {
    // The ledger writes opened_at as 2026-09-04T13:20:00.000Z; the signal bus
    // defaults to SQLite's 2026-09-04 13:20:00. As raw strings ' ' sorts below
    // 'T', so every comparison returned false and no time-based condition could
    // ever fire. Both sides go through datetime() now.
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, data, created_at)
       VALUES ('t','filing_8k','NVDA','{}', '2026-09-03 10:00:00')`,
    ).run();
    expect(newFilingSince(db, 'NVDA', '2026-09-01T00:00:00.000Z')).toBe(true);
    expect(newFilingSince(db, 'NVDA', '2026-09-04T00:00:00.000Z')).toBe(false);
  });

  it('works when both sides are ISO', () => {
    signal('filing_8k', 'NVDA', '2026-09-03T10:00:00.000Z');
    expect(newFilingSince(db, 'NVDA', '2026-09-01T00:00:00.000Z')).toBe(true);
  });

  it('works for opposing news across the format boundary', () => {
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, data, created_at)
       VALUES ('t','news_signal','NVDA',?, '2026-09-03 10:00:00')`,
    ).run(JSON.stringify({ direction: -0.9, materiality: 80 }));
    expect(opposingNewsSince(db, 'NVDA', '2026-09-01T00:00:00.000Z', 'long')).toBe(80);
  });
});

describe('schema strictness', () => {
  it('rejects a zero-day condition — it would fire the instant it was written', () => {
    expect(readConditions(JSON.stringify([{ kind: 'DAYS_ELAPSED', value: 0, why: 'x' }])).conditions)
      .toHaveLength(0);
  });

  it('rejects an unknown condition kind rather than ignoring it silently', () => {
    const r = readConditions(JSON.stringify([{ kind: 'VIBES', why: 'x' }]));
    expect(r.conditions).toHaveLength(0);
    expect(r.unevaluable).toBe(1);
  });

  it('rejects a materiality outside 0-100', () => {
    expect(readConditions(JSON.stringify([
      { kind: 'CONTRADICTING_NEWS', minMateriality: 500, why: 'x' },
    ])).conditions).toHaveLength(0);
  });
});

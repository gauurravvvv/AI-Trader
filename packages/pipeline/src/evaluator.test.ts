import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import {
  closedTrades, summarise, maxDrawdown, compareToBenchmark,
  byConfidence, bySource, performanceReport, type ClosedTrade,
} from './evaluator.js';

const t = (pnl: string, over: Partial<ClosedTrade> = {}): ClosedTrade => ({
  symbol: 'NVDA', venue: 'sim-us', qty: '10', entry: '100', exit: '110',
  pnl, openedAt: '2026-09-01', closedAt: '2026-09-04', heldDays: 3,
  source: 'earnings', auditScore: 80, ...over,
});

describe('summarise', () => {
  it('reports an empty book without dividing by zero', () => {
    const p = summarise([]);
    expect(p.trades).toBe(0);
    expect(p.winRate).toBe(0);
    expect(p.realised).toBe('0.00');
    expect(p.profitFactor).toBeNull();
  });

  it('separates wins from losses and totals both', () => {
    const p = summarise([t('100'), t('-40'), t('60'), t('-20')]);
    expect(p.wins).toBe(2);
    expect(p.losses).toBe(2);
    expect(p.winRate).toBe(0.5);
    expect(p.realised).toBe('100.00');
    expect(p.grossWin).toBe('160.00');
    expect(p.grossLoss).toBe('60.00');
    expect(p.profitFactor).toBeCloseTo(2.667, 2);
  });

  it('treats a scratch trade as neither a win nor a loss', () => {
    const p = summarise([t('0')]);
    expect(p.wins).toBe(0);
    expect(p.losses).toBe(0);
  });

  it('reports profit factor as null rather than Infinity when nothing has lost', () => {
    // Infinity off three trades is not a result, it is a small sample.
    expect(summarise([t('10'), t('20')]).profitFactor).toBeNull();
  });
});

describe('maxDrawdown', () => {
  it('is zero for a book that only ever went up', () => {
    expect(maxDrawdown([t('10'), t('20'), t('5')]).toFixed(2)).toBe('0.00');
  });

  it('measures peak to trough, not first to worst', () => {
    // +100 -> peak 100, then -30 -> 70, then -20 -> 50: drawdown 50.
    expect(maxDrawdown([t('100'), t('-30'), t('-20')]).toFixed(2)).toBe('50.00');
  });

  it('keeps the deepest earlier fall when the book recovers and dips again', () => {
    expect(maxDrawdown([t('100'), t('-80'), t('100'), t('-30')]).toFixed(2)).toBe('80.00');
  });

  it('handles a book that is underwater from the first trade', () => {
    expect(maxDrawdown([t('-50')]).toFixed(2)).toBe('50.00');
  });
});

describe('compareToBenchmark', () => {
  it('refuses to judge on too few trades', () => {
    const r = compareToBenchmark('5000', '100000', 400, 440, 4);
    expect(r.verdict).toBe('INSUFFICIENT_DATA');
  });

  it('calls it LAGGING when buy-and-hold did better', () => {
    // Strategy +5%, SPY +10%.
    const r = compareToBenchmark('5000', '100000', 400, 440, 30);
    expect(r.strategyReturn).toBeCloseTo(0.05);
    expect(r.benchmarkReturn).toBeCloseTo(0.1);
    expect(r.excessReturn).toBeCloseTo(-0.05);
    expect(r.verdict).toBe('LAGGING');
  });

  it('calls it BEATING only when the excess is genuinely positive', () => {
    expect(compareToBenchmark('12000', '100000', 400, 440, 30).verdict).toBe('BEATING');
  });

  it('counts a flat strategy in a falling market as beating', () => {
    const r = compareToBenchmark('0', '100000', 400, 360, 30);
    expect(r.benchmarkReturn).toBeCloseTo(-0.1);
    expect(r.verdict).toBe('BEATING');
  });

  it('does not divide by a zero benchmark price', () => {
    expect(compareToBenchmark('100', '100000', 0, 440, 30).benchmarkReturn).toBe(0);
  });
});

describe('attribution', () => {
  it('splits by auditor confidence so a useless score is visible', () => {
    const buckets = byConfidence([
      t('100', { auditScore: 90 }), t('50', { auditScore: 90 }),
      t('-80', { auditScore: 72 }), t('-20', { auditScore: 72 }),
    ]);
    const high = buckets.find((b) => b.tier === '85+')!;
    const mid = buckets.find((b) => b.tier === '70-84')!;
    expect(high.winRate).toBe(1);
    expect(mid.winRate).toBe(0);
    expect(mid.realised).toBe('-100.00');
  });

  it('buckets an unscored trade separately rather than assuming zero', () => {
    expect(byConfidence([t('10', { auditScore: null })])[0]!.tier).toBe('unscored');
  });

  it('splits by originating agent', () => {
    const s = bySource([t('100', { source: 'news' }), t('-50', { source: 'earnings' })]);
    expect(s.map((b) => b.tier).sort()).toEqual(['earnings', 'news']);
  });
});

describe('performanceReport', () => {
  it('says plainly when buy-and-hold is winning', () => {
    const p = summarise([t('10'), t('-20')]);
    const b = compareToBenchmark('-10', '100000', 400, 440, 30);
    const out = performanceReport(p, b, [], []);
    expect(out).toContain('LAGGING');
    expect(out).toContain('Buy-and-hold is ahead');
  });

  it('refuses to imply a verdict from a handful of trades', () => {
    const out = performanceReport(summarise([t('10')]), compareToBenchmark('10', '100000', 400, 440, 1), [], []);
    expect(out).toContain('noise wearing a percentage sign');
  });
});

// ── Against the real schema ─────────────────────────────────────────────────

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });

function seedClosed(symbol: string, pnl: string, auditScore: number | null, rationale: string): void {
  db.prepare(
    `INSERT INTO decisions (symbol, market, venue, side, audit_score, rationale, status)
     VALUES (?, 'US', 'sim-us', 'buy', ?, ?, 'EXECUTED')`,
  ).run(symbol, auditScore, rationale);
  db.prepare(
    `INSERT INTO positions (venue, symbol, qty, avg_cost, realised_pnl, opened_at, closed_at)
     VALUES ('sim-us', ?, '0', '100', ?, '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z')`,
  ).run(symbol, pnl);
}

describe('closedTrades', () => {
  it('reads closed positions out of the ledger', () => {
    seedClosed('NVDA', '250', 88, 'guidance raised');
    const out = closedTrades(db, 'sim-us');
    expect(out).toHaveLength(1);
    expect(out[0]!.pnl).toBe('250');
    expect(out[0]!.auditScore).toBe(88);
    expect(out[0]!.heldDays).toBe(4);
  });

  it('ignores a position that is still open', () => {
    db.prepare(
      `INSERT INTO positions (venue, symbol, qty, avg_cost, realised_pnl, opened_at)
       VALUES ('sim-us', 'AAPL', '10', '100', '0', '2026-09-01T00:00:00Z')`,
    ).run();
    // Scoring the realised half of a still-open position is the oldest way to
    // make a losing book look profitable.
    expect(closedTrades(db, 'sim-us')).toHaveLength(0);
  });

  it('attributes a trade to the agent that opened it', () => {
    seedClosed('NVDA', '10', 80, 'news: big contract — Nvidia wins deal');
    seedClosed('AMD', '10', 80, 'guidance raised on demand');
    const sources = closedTrades(db, 'sim-us').map((t) => t.source).sort();
    expect(sources).toEqual(['earnings', 'news']);
  });

  it('scopes to a venue when asked', () => {
    seedClosed('NVDA', '10', 80, 'x');
    expect(closedTrades(db, 'sim-crypto')).toHaveLength(0);
    expect(closedTrades(db)).toHaveLength(1);
  });
});

// ── Random-entry control ────────────────────────────────────────────────────

import { randomEntryControl, controlReport, seededRandom, type ControlTrade } from './evaluator.js';

const window = (symbol: string, actualReturn: number): ControlTrade => ({
  symbol, openedAt: '2026-09-01', closedAt: '2026-09-10', actualReturn,
});

/** Every random pick returns this much, so the control is exactly predictable. */
const flat = (r: number) => () => Promise.resolve(r);

describe('seededRandom', () => {
  it('is reproducible — a control you can re-roll is not a control', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('stays inside [0,1)', () => {
    const r = seededRandom(7);
    for (let i = 0; i < 200; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces different streams for different seeds', () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });
});

describe('randomEntryControl', () => {
  const universe = ['NVDA', 'AMD', 'INTC', 'MU'];
  const many = (n: number, r: number): ControlTrade[] =>
    Array.from({ length: n }, () => window('NVDA', r));

  it('says our entries beat random when they did', async () => {
    const c = await randomEntryControl(many(25, 0.06), universe, flat(0.01));
    expect(c.strategyReturn).toBeCloseTo(0.06);
    expect(c.meanReturn).toBeCloseTo(0.01);
    expect(c.edgeOverRandom).toBeCloseTo(0.05);
    expect(c.verdict).toBe('BEATS_RANDOM');
  });

  it('says so when a coin flip did just as well', async () => {
    // A book that beats the index by holding high-beta names in a rally will
    // beat SPY and tie with random. Only this comparison catches it.
    const c = await randomEntryControl(many(25, 0.04), universe, flat(0.05));
    expect(c.verdict).toBe('NO_BETTER_THAN_RANDOM');
    expect(controlReport(c)).toContain('did');
    expect(controlReport(c)).toContain('not adding');
  });

  it('refuses a verdict below the trade threshold', async () => {
    const c = await randomEntryControl(many(5, 0.5), universe, flat(0));
    expect(c.verdict).toBe('INSUFFICIENT_DATA');
  });

  it('takes several draws per window to damp one unlucky pick', async () => {
    const seen: string[] = [];
    await randomEntryControl(many(20, 0.01), universe, (s) => {
      seen.push(s);
      return Promise.resolve(0.01);
    }, { draws: 4 });
    expect(seen).toHaveLength(80);
  });

  it('skips a symbol with no price history rather than scoring it as zero', async () => {
    const c = await randomEntryControl(
      many(20, 0.05), universe,
      (s) => Promise.resolve(s === 'NVDA' ? null : 0.02),
    );
    expect(c.samples).toBeLessThan(100);
    expect(c.meanReturn).toBeCloseTo(0.02);
  });

  it('is reproducible for the same seed', async () => {
    const run = (): Promise<{ meanReturn: number }> =>
      randomEntryControl(many(20, 0.03), universe,
        (s) => Promise.resolve(s === 'NVDA' ? 0.1 : 0.0),
        { rand: seededRandom(99) });
    expect((await run()).meanReturn).toBe((await run()).meanReturn);
  });

  it('handles an empty book and an empty universe', async () => {
    expect((await randomEntryControl([], universe, flat(0))).verdict).toBe('INSUFFICIENT_DATA');
    expect((await randomEntryControl(many(30, 0.1), [], flat(0))).verdict).toBe('INSUFFICIENT_DATA');
  });
});

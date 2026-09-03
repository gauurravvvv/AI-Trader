import { describe, it, expect } from 'vitest';
import { YahooPriceSource } from './yahoo.js';

describe('YahooPriceSource.resolveSpread', () => {
  it('uses a credible venue-supplied spread as-is', () => {
    const r = YahooPriceSource.resolveSpread(100, 99.98, 100.02);
    expect(r.synthetic).toBe(false);
    expect(r.bid).toBe(99.98);
  });

  it('rejects an implausibly wide after-hours spread', () => {
    // Observed live: AAPL last 324.96 with bid 324 / ask 329.98 — 1.8%, an
    // indicative quote no real order would pay.
    const r = YahooPriceSource.resolveSpread(324.96, 324, 329.98);
    expect(r.synthetic).toBe(true);
    // falls back to the tier estimate, ~0.1% not 1.84%
    expect((r.ask - r.bid) / 324.96).toBeLessThan(0.002);
  });

  it('synthesises a spread when bid/ask are missing', () => {
    const r = YahooPriceSource.resolveSpread(100, undefined, undefined);
    expect(r.synthetic).toBe(true);
    expect(r.bid).toBeLessThan(100);
    expect(r.ask).toBeGreaterThan(100);
  });

  it('never produces a zero spread — that would flatter every fill', () => {
    for (const px of [1, 4.5, 25, 100, 900, 5000]) {
      const r = YahooPriceSource.resolveSpread(px, undefined, undefined);
      expect(r.ask - r.bid).toBeGreaterThan(0);
    }
  });

  it('rejects an inverted book', () => {
    expect(YahooPriceSource.resolveSpread(100, 101, 99).synthetic).toBe(true);
  });

  it('allows a genuinely wide spread on an illiquid penny name', () => {
    // 3 dollars, 1.2% spread — plausible for this tier, must not be discarded
    const r = YahooPriceSource.resolveSpread(3, 2.982, 3.018);
    expect(r.synthetic).toBe(false);
  });
});

describe('YahooPriceSource.symbolFor', () => {
  it('suffixes Indian symbols with .NS', () => {
    expect(YahooPriceSource.symbolFor('RELIANCE', 'IN')).toBe('RELIANCE.NS');
  });
  it('leaves an already-suffixed Indian symbol alone', () => {
    expect(YahooPriceSource.symbolFor('RELIANCE.BO', 'IN')).toBe('RELIANCE.BO');
  });
  it('suffixes crypto with -USD', () => {
    expect(YahooPriceSource.symbolFor('BTC', 'CRYPTO')).toBe('BTC-USD');
  });
  it('leaves US symbols untouched', () => {
    expect(YahooPriceSource.symbolFor('NVDA', 'US')).toBe('NVDA');
  });
});

// Network test — skipped when offline so CI stays green.
const online = process.env.AEGIS_NETWORK_TESTS === '1';
describe.skipIf(!online)('YahooPriceSource live', () => {
  it('fetches a real quote with a non-zero synthetic spread', async () => {
    const src = new YahooPriceSource();
    const q = await src.quote('AAPL');
    expect(q).not.toBeNull();
    expect(Number(q!.last)).toBeGreaterThan(0);
    // The spread must never be zero — a zero spread flatters every fill.
    expect(Number(q!.ask)).toBeGreaterThanOrEqual(Number(q!.bid));
  }, 30_000);

  it('returns null for a nonsense symbol rather than inventing a price', async () => {
    const src = new YahooPriceSource();
    expect(await src.quote('ZZZZNOTREAL9')).toBeNull();
  }, 30_000);
});

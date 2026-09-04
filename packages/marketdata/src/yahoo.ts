import YahooFinance from 'yahoo-finance2';
import type { PriceSource, Quote } from '@aegis/brokers';

export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CacheEntry {
  quote: Quote;
  at: number;
}

/**
 * A venue spread is credible up to this multiple of what the price tier
 * predicts. An absolute cap does not work: 2% is absurd for AAPL and tight for
 * a penny stock. Observed live — AAPL last 324.96 with bid 324 / ask 329.98 is
 * 1.84%, roughly 18x the ~0.1% a $325 name actually trades at.
 */
const CREDIBLE_SPREAD_MULTIPLE = 8;

/**
 * Keyless market data. No signup, no API key, no vendor account.
 *
 * Two deliberate corrections to what Yahoo returns:
 *
 * 1. When bid/ask are missing, we synthesise a spread from a price-tier table
 *    rather than treating the spread as zero — a zero spread would make the
 *    fill simulator flatter every single trade.
 * 2. When bid/ask are present but implausibly wide relative to the price tier,
 *    we fall back to the synthetic spread. After hours Yahoo reports indicative
 *    quotes — AAPL showed 324/329.98, a 1.84% spread on a name that trades near
 *    0.01%. Taking that literally would model a cost no real order would pay.
 */
export class YahooPriceSource implements PriceSource {
  private readonly yf: InstanceType<typeof YahooFinance>;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs = 15_000) {
    this.yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  /** `RELIANCE` on the Indian market becomes `RELIANCE.NS` for Yahoo. */
  static symbolFor(symbol: string, market: 'US' | 'IN' | 'CRYPTO'): string {
    if (market === 'IN' && !symbol.includes('.')) return `${symbol}.NS`;
    if (market === 'CRYPTO' && !symbol.includes('-')) return `${symbol}-USD`;
    return symbol;
  }

  /** Synthetic half-spread as a fraction of price. Never zero. */
  static syntheticHalfSpread(last: number): number {
    if (last < 5) return 0.004;
    if (last < 50) return 0.0012;
    if (last < 500) return 0.0005;
    return 0.0003;
  }

  /** Exported for testing: decide bid/ask from what Yahoo gave us. */
  static resolveSpread(
    last: number,
    rawBid: number | undefined,
    rawAsk: number | undefined,
  ): { bid: number; ask: number; synthetic: boolean } {
    const half = last * YahooPriceSource.syntheticHalfSpread(last);
    const cap = half * 2 * CREDIBLE_SPREAD_MULTIPLE;

    const usable =
      typeof rawBid === 'number' &&
      typeof rawAsk === 'number' &&
      rawBid > 0 &&
      rawAsk > 0 &&
      rawAsk >= rawBid &&
      rawAsk - rawBid <= cap;

    if (usable) return { bid: rawBid, ask: rawAsk, synthetic: false };
    return { bid: last - half, ask: last + half, synthetic: true };
  }

  async quote(symbol: string): Promise<Quote | null> {
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.quote;

    try {
      const q = await this.yf.quote(symbol);
      const last = q.regularMarketPrice;
      if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) return null;

      const { bid, ask, synthetic } = YahooPriceSource.resolveSpread(last, q.bid, q.ask);

      const quote: Quote = {
        symbol,
        last: String(last),
        bid: String(bid),
        ask: String(ask),
        volume: String(q.regularMarketVolume ?? 0),
        at: new Date().toISOString(),
        // Travels with the quote: a decision priced off a synthesised spread is
        // weaker than one priced off a real book, and provenance records it.
        synthetic,
      };
      this.cache.set(symbol, { quote, at: Date.now() });
      return quote;
    } catch {
      // A data outage must degrade to "no quote", never to a fabricated one.
      return null;
    }
  }

  async bars(symbol: string, days = 90): Promise<Bar[]> {
    try {
      const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const res = await this.yf.chart(symbol, { period1, interval: '1d' });
      const rows = res.quotes as {
        date: Date | string;
        open?: number | null;
        high?: number | null;
        low?: number | null;
        close?: number | null;
        volume?: number | null;
      }[];
      return rows
        .filter((r): r is typeof r & { close: number } => typeof r.close === 'number')
        .map((r) => ({
          t: new Date(r.date).toISOString(),
          o: r.open ?? 0,
          h: r.high ?? 0,
          l: r.low ?? 0,
          c: r.close,
          v: r.volume ?? 0,
        }));
    } catch {
      return [];
    }
  }

  /** Clear the cache — called after a suspend, when every price is stale. */
  clear(): void {
    this.cache.clear();
  }
}

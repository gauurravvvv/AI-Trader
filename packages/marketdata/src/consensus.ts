import YahooFinance from 'yahoo-finance2';

export interface QuarterSurprise {
  quarterEnd: string;
  epsActual: number;
  epsEstimate: number;
  epsDifference: number;
  surprisePercent: number;
}

export interface ConsensusSnapshot {
  symbol: string;
  /** Consensus EPS for the quarter currently being reported. */
  currentQuarterEps: number | null;
  currentQuarterRevenue: number | null;
  /** Prior quarters, newest last. Used to standardise the surprise. */
  history: QuarterSurprise[];
  nextEarningsDate: string | null;
  retrievedAt: string;
}

/**
 * Consensus estimates, keyless.
 *
 * Necessary because a company's own 8-K states what it earned but never what
 * was expected — "revenue of $96.2 billion, up 106%" with no mention of the
 * $94B the street modelled. Surprise cannot be derived from the filing alone,
 * which is exactly what the first live run of the Earnings Reader demonstrated
 * when it correctly returned UNCLEAR.
 */
export class YahooConsensus {
  private readonly yf: InstanceType<typeof YahooFinance>;
  private readonly cache = new Map<string, { snap: ConsensusSnapshot; at: number }>();

  constructor(private readonly ttlMs = 6 * 60 * 60 * 1000) {
    this.yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  async get(symbol: string): Promise<ConsensusSnapshot | null> {
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.snap;

    try {
      const s = await this.yf.quoteSummary(symbol, {
        modules: ['earningsHistory', 'earningsTrend', 'calendarEvents'],
      });

      const history: QuarterSurprise[] = (s.earningsHistory?.history ?? [])
        .filter(
          (h): h is typeof h & { epsActual: number; epsEstimate: number } =>
            typeof h.epsActual === 'number' && typeof h.epsEstimate === 'number',
        )
        .map((h) => ({
          quarterEnd: new Date(h.quarter as unknown as string).toISOString().slice(0, 10),
          epsActual: h.epsActual,
          epsEstimate: h.epsEstimate,
          epsDifference: h.epsDifference ?? h.epsActual - h.epsEstimate,
          surprisePercent: h.surprisePercent ?? 0,
        }))
        .sort((a, b) => (a.quarterEnd < b.quarterEnd ? -1 : 1));

      const trend = s.earningsTrend?.trend ?? [];
      const cur = trend.find((t) => t.period === '0q');

      const dates = s.calendarEvents?.earnings?.earningsDate ?? [];
      const nextEarningsDate =
        dates.length > 0 ? new Date(dates[0] as unknown as string).toISOString().slice(0, 10) : null;

      const snap: ConsensusSnapshot = {
        symbol,
        currentQuarterEps: cur?.earningsEstimate?.avg ?? null,
        currentQuarterRevenue: cur?.revenueEstimate?.avg ?? null,
        history,
        nextEarningsDate,
        retrievedAt: new Date().toISOString(),
      };
      this.cache.set(symbol, { snap, at: Date.now() });
      return snap;
    } catch {
      return null;
    }
  }
}

/**
 * Standardised Unexpected Earnings.
 *
 * SUE = (actual − expected) / stdev(recent surprises). Dividing by the firm's
 * own surprise volatility is the point: a 5c beat means something very
 * different at a company that lands within a cent every quarter than at one
 * that swings by 50c. A raw dollar or percentage surprise conflates the two.
 */
export function standardisedSue(
  epsActual: number,
  epsEstimate: number,
  history: QuarterSurprise[],
): { sue: number; stdev: number; basis: 'history' | 'fallback' } {
  const diff = epsActual - epsEstimate;
  const past = history.map((h) => h.epsDifference);

  if (past.length < 3) {
    // Too few observations to estimate dispersion. Fall back to scaling by the
    // estimate itself, and say so rather than fabricating a stdev.
    const denom = Math.max(Math.abs(epsEstimate) * 0.05, 0.01);
    return { sue: diff / denom, stdev: denom, basis: 'fallback' };
  }

  const mean = past.reduce((a, b) => a + b, 0) / past.length;
  const variance = past.reduce((a, b) => a + (b - mean) ** 2, 0) / (past.length - 1);
  // Guard a degenerate series: a company that has hit the estimate exactly
  // every quarter would divide by zero.
  const stdev = Math.max(Math.sqrt(variance), Math.abs(epsEstimate) * 0.01, 0.01);
  return { sue: diff / stdev, stdev, basis: 'history' };
}

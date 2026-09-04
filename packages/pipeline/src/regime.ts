import { BaseAgent } from '@aegis/agents';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { PipelineDeps } from './agents.js';

export const SIG_REGIME = 'market_regime';

export type Regime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export interface RegimeRead {
  regime: Regime;
  /** Index move over the lookback, as a fraction. */
  trend: number;
  /** Realised daily volatility over the lookback, annualised-ish. */
  volatility: number;
  /** Fraction of tracked names above their own 20-day average. */
  breadth: number;
  detail: string;
}

/**
 * Overall market posture, from prices alone.
 *
 * No model call. This is arithmetic on bars, it runs every few minutes, and a
 * regime read that stops working when the credit runs out is worse than
 * useless — it is the input every other decision is scaled by.
 *
 * Three inputs, because any one of them lies on its own: trend says which way
 * the index went, volatility says whether that move was orderly, and breadth
 * says whether the market went with it or a handful of names carried it.
 */
export function classifyRegime(
  indexCloses: number[],
  breadth: number,
  opts: { riskOnTrend?: number; riskOffTrend?: number; highVol?: number } = {},
): RegimeRead {
  const riskOnTrend = opts.riskOnTrend ?? 0.01;
  const riskOffTrend = opts.riskOffTrend ?? -0.015;
  const highVol = opts.highVol ?? 0.018;

  if (indexCloses.length < 5) {
    return {
      regime: 'NEUTRAL', trend: 0, volatility: 0, breadth,
      detail: 'not enough index history to judge',
    };
  }

  const first = indexCloses[0] ?? 0;
  const last = indexCloses.at(-1) ?? 0;
  const trend = first > 0 ? (last - first) / first : 0;

  const rets: number[] = [];
  for (let i = 1; i < indexCloses.length; i += 1) {
    const a = indexCloses[i - 1] ?? 0;
    const b = indexCloses[i] ?? 0;
    if (a > 0) rets.push((b - a) / a);
  }
  const mean = rets.reduce((x, y) => x + y, 0) / Math.max(1, rets.length);
  const volatility = Math.sqrt(
    rets.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, rets.length - 1),
  );

  // Volatility overrides trend. A market rising fast on wide daily swings is
  // not risk-on; it is a market that can hand the move back overnight, and
  // sizing into it on the strength of the trend alone is how a good week is
  // given up in one session.
  let regime: Regime;
  let detail: string;
  if (volatility >= highVol) {
    regime = 'RISK_OFF';
    detail = `daily vol ${(volatility * 100).toFixed(2)}% is elevated — trend is not trustworthy`;
  } else if (trend <= riskOffTrend || breadth < 0.35) {
    regime = 'RISK_OFF';
    detail = `index ${(trend * 100).toFixed(2)}%, breadth ${(breadth * 100).toFixed(0)}%`;
  } else if (trend >= riskOnTrend && breadth >= 0.55) {
    regime = 'RISK_ON';
    detail = `index ${(trend * 100).toFixed(2)}%, breadth ${(breadth * 100).toFixed(0)}%`;
  } else {
    regime = 'NEUTRAL';
    detail = `index ${(trend * 100).toFixed(2)}%, breadth ${(breadth * 100).toFixed(0)}%, vol ${(volatility * 100).toFixed(2)}%`;
  }
  return { regime, trend, volatility, breadth, detail };
}

/**
 * How much of the normal position size this regime permits.
 *
 * Risk-off does not stop trading — a bearish read is more valuable when the
 * market is falling, not less. It shrinks longs and leaves shorts alone.
 */
export function sizeMultiplier(regime: Regime, direction: 'long' | 'short'): number {
  if (regime === 'RISK_ON') return direction === 'long' ? 1 : 0.6;
  if (regime === 'RISK_OFF') return direction === 'long' ? 0.4 : 1;
  return 0.75;
}

export interface RegimeDeps extends PipelineDeps {
  prices: YahooPriceSource;
  /** Index to read the trend from. */
  indexSymbol?: string;
  /** Names to measure breadth across. Defaults to the universe. */
  breadthSymbols?: string[];
  lookbackDays?: number;
}

export class MarketRegimeAgent extends BaseAgent {
  constructor(private readonly r: RegimeDeps) {
    super('market-regime', { intervalMs: 15 * 60 * 1000 }, r);
  }

  async execute(): Promise<void> {
    const index = this.r.indexSymbol ?? 'SPY';
    const lookback = this.r.lookbackDays ?? 20;

    const bars = await this.r.prices.bars(index, lookback + 5);
    const closes = bars.map((b) => b.c).filter((c) => Number.isFinite(c) && c > 0);
    if (closes.length < 5) {
      this.log.warn(this.name, `${index}: not enough history to judge the regime`);
      return;
    }

    const breadth = await this.breadth();
    const read = classifyRegime(closes.slice(-lookback), breadth);

    this.log.event(
      this.name,
      `${read.regime}  ${read.detail}  (longs x${String(sizeMultiplier(read.regime, 'long'))}, shorts x${String(sizeMultiplier(read.regime, 'short'))})`,
    );
    this.bus.emit({
      agent: this.name,
      signalType: SIG_REGIME,
      confidence: Math.round(read.breadth * 100),
      data: { ...read },
    });
  }

  /** Fraction of tracked names trading above their own 20-day average. */
  private async breadth(): Promise<number> {
    const symbols = this.r.breadthSymbols ?? this.r.universe.map((e) => e.symbol);
    if (symbols.length === 0) return 0.5;
    let above = 0;
    let counted = 0;
    for (const s of symbols) {
      const bars = await this.r.prices.bars(s, 25);
      const closes = bars.map((b) => b.c).filter((c) => Number.isFinite(c) && c > 0);
      if (closes.length < 10) continue;
      const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
      const last = closes.at(-1) ?? 0;
      counted += 1;
      if (last > avg) above += 1;
    }
    // No data is not the same as a balanced market; say neutral and move on.
    return counted === 0 ? 0.5 : above / counted;
  }
}

/** Latest regime from the bus, or NEUTRAL when nothing has been read yet. */
export function currentRegime(read: { data: Record<string, unknown> }[] | undefined): Regime {
  const d = read?.[0]?.data;
  const r = d?.['regime'];
  return r === 'RISK_ON' || r === 'RISK_OFF' ? r : 'NEUTRAL';
}

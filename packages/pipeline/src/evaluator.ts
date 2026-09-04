import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';

export interface ClosedTrade {
  symbol: string;
  venue: string;
  qty: string;
  entry: string;
  exit: string;
  pnl: string;
  openedAt: string;
  closedAt: string;
  heldDays: number;
  /** Which agent's decision opened it, when the lineage survives. */
  source: string | null;
  auditScore: number | null;
}

export interface Performance {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realised: string;
  grossWin: string;
  grossLoss: string;
  /** Gross win divided by gross loss. Above 1 means the winners paid for the losers. */
  profitFactor: number | null;
  avgWin: string;
  avgLoss: string;
  /** Largest peak-to-trough fall in the running realised curve. */
  maxDrawdown: string;
  avgHeldDays: number;
  feesPaid: string;
}

/**
 * Closed round trips, reconstructed from the ledger.
 *
 * A position counts as closed only when `closed_at` is set, so a half-exited
 * position is not scored as a win on the part that was sold. Judging a strategy
 * on its realised half while the unrealised half is still underwater is the
 * oldest way to make a losing book look profitable.
 */
export function closedTrades(db: Db, venue?: string): ClosedTrade[] {
  const rows = db
    .prepare(
      `SELECT p.symbol, p.venue, p.realised_pnl, p.opened_at, p.closed_at,
              d.audit_score, d.rationale
         FROM positions p
         LEFT JOIN decisions d
           ON d.symbol = p.symbol AND d.venue = p.venue AND d.side = 'buy'
         WHERE p.closed_at IS NOT NULL ${venue === undefined ? '' : 'AND p.venue = ?'}
         GROUP BY p.id
         ORDER BY p.closed_at ASC`,
    )
    .all(...(venue === undefined ? [] : [venue])) as {
    symbol: string;
    venue: string;
    realised_pnl: string;
    opened_at: string | null;
    closed_at: string;
    audit_score: number | null;
    rationale: string | null;
  }[];

  return rows.map((r) => ({
    symbol: r.symbol,
    venue: r.venue,
    qty: '0',
    entry: '0',
    exit: '0',
    pnl: r.realised_pnl,
    openedAt: r.opened_at ?? r.closed_at,
    closedAt: r.closed_at,
    heldDays: daysBetween(r.opened_at, r.closed_at),
    source: r.rationale === null ? null : r.rationale.startsWith('news:') ? 'news' : 'earnings',
    auditScore: r.audit_score,
  }));
}

function daysBetween(a: string | null, b: string): number {
  if (a === null) return 0;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.round(ms / 86_400_000));
}

export function summarise(trades: ClosedTrade[], feesPaid = '0'): Performance {
  const wins = trades.filter((t) => new Decimal(t.pnl).gt(0));
  const losses = trades.filter((t) => new Decimal(t.pnl).lt(0));
  const sum = (xs: ClosedTrade[]): Decimal =>
    xs.reduce((a, t) => a.plus(t.pnl), new Decimal(0));

  const grossWin = sum(wins);
  const grossLoss = sum(losses).abs();

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    realised: sum(trades).toFixed(2),
    grossWin: grossWin.toFixed(2),
    grossLoss: grossLoss.toFixed(2),
    // Undefined rather than Infinity when nothing has lost yet: a profit factor
    // of Infinity off three trades is not a result, it is a small sample.
    profitFactor: grossLoss.eq(0) ? null : grossWin.div(grossLoss).toNumber(),
    avgWin: wins.length === 0 ? '0.00' : grossWin.div(wins.length).toFixed(2),
    avgLoss: losses.length === 0 ? '0.00' : grossLoss.div(losses.length).toFixed(2),
    maxDrawdown: maxDrawdown(trades).toFixed(2),
    avgHeldDays:
      trades.length === 0 ? 0 : trades.reduce((a, t) => a + t.heldDays, 0) / trades.length,
    feesPaid,
  };
}

/** Largest peak-to-trough fall in the running realised curve. */
export function maxDrawdown(trades: ClosedTrade[]): Decimal {
  let equity = new Decimal(0);
  let peak = new Decimal(0);
  let worst = new Decimal(0);
  for (const t of trades) {
    equity = equity.plus(t.pnl);
    if (equity.gt(peak)) peak = equity;
    const dd = peak.minus(equity);
    if (dd.gt(worst)) worst = dd;
  }
  return worst;
}

export interface BenchmarkResult {
  /** Return of the strategy, as a fraction of starting equity. */
  strategyReturn: number;
  /** Return of holding the benchmark over the same window. */
  benchmarkReturn: number;
  /** Strategy minus benchmark. Negative means buy-and-hold won. */
  excessReturn: number;
  benchmarkSymbol: string;
  verdict: 'BEATING' | 'LAGGING' | 'INSUFFICIENT_DATA';
}

/**
 * Compare against doing nothing.
 *
 * This is the only comparison that matters and the one most systems avoid.
 * StockBench (ICLR 2026) found most LLM trading agents fail to beat buy-and-hold;
 * a strategy that made money in a rising market has demonstrated nothing until
 * it is measured against the market that rose.
 *
 * Below `minTrades` the answer is INSUFFICIENT_DATA rather than a number. A
 * win rate over four trades is noise wearing a percentage sign.
 */
export function compareToBenchmark(
  realisedPnl: string,
  startingEquity: string,
  benchmarkStart: number,
  benchmarkEnd: number,
  trades: number,
  benchmarkSymbol = 'SPY',
  minTrades = 20,
): BenchmarkResult {
  const eq = new Decimal(startingEquity);
  const strategyReturn = eq.gt(0) ? new Decimal(realisedPnl).div(eq).toNumber() : 0;
  const benchmarkReturn =
    benchmarkStart > 0 ? (benchmarkEnd - benchmarkStart) / benchmarkStart : 0;
  const excessReturn = strategyReturn - benchmarkReturn;
  return {
    strategyReturn,
    benchmarkReturn,
    excessReturn,
    benchmarkSymbol,
    verdict:
      trades < minTrades ? 'INSUFFICIENT_DATA' : excessReturn > 0 ? 'BEATING' : 'LAGGING',
  };
}

export interface TierBucket {
  tier: string;
  trades: number;
  winRate: number;
  realised: string;
}

/**
 * Performance split by the Auditor's confidence at entry.
 *
 * If the high-confidence bucket does not outperform the low-confidence one, the
 * confidence score is decoration and should stop gating anything.
 */
export function byConfidence(trades: ClosedTrade[]): TierBucket[] {
  const bucket = (t: ClosedTrade): string => {
    if (t.auditScore === null) return 'unscored';
    if (t.auditScore >= 85) return '85+';
    if (t.auditScore >= 70) return '70-84';
    return 'below-70';
  };
  const groups = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const k = bucket(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([tier, ts]) => {
      const wins = ts.filter((t) => new Decimal(t.pnl).gt(0)).length;
      return {
        tier,
        trades: ts.length,
        winRate: ts.length === 0 ? 0 : wins / ts.length,
        realised: ts.reduce((a, t) => a.plus(t.pnl), new Decimal(0)).toFixed(2),
      };
    })
    .sort((a, b) => a.tier.localeCompare(b.tier));
}

/** Performance split by which agent originated the entry. */
export function bySource(trades: ClosedTrade[]): TierBucket[] {
  const groups = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const k = t.source ?? 'unknown';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()].map(([tier, ts]) => {
    const wins = ts.filter((t) => new Decimal(t.pnl).gt(0)).length;
    return {
      tier,
      trades: ts.length,
      winRate: ts.length === 0 ? 0 : wins / ts.length,
      realised: ts.reduce((a, t) => a.plus(t.pnl), new Decimal(0)).toFixed(2),
    };
  });
}

export function performanceReport(
  p: Performance,
  bench: BenchmarkResult,
  conf: TierBucket[],
  src: TierBucket[],
): string {
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const lines = [
    'PERFORMANCE',
    `  Closed trades:   ${String(p.trades)}  (${String(p.wins)}W / ${String(p.losses)}L, ${pct(p.winRate)})`,
    `  Realised P&L:    ${p.realised}`,
    `  Fees paid:       ${p.feesPaid}`,
    `  Profit factor:   ${p.profitFactor === null ? 'n/a (nothing has lost yet)' : p.profitFactor.toFixed(2)}`,
    `  Avg win / loss:  ${p.avgWin} / ${p.avgLoss}`,
    `  Max drawdown:    ${p.maxDrawdown}`,
    `  Avg hold:        ${p.avgHeldDays.toFixed(1)} days`,
    '',
    'VERSUS DOING NOTHING',
    `  Strategy:        ${pct(bench.strategyReturn)}`,
    `  ${bench.benchmarkSymbol.padEnd(16)} ${pct(bench.benchmarkReturn)}`,
    `  Excess:          ${pct(bench.excessReturn)}`,
    `  Verdict:         ${bench.verdict}`,
  ];
  if (bench.verdict === 'INSUFFICIENT_DATA') {
    lines.push(
      '',
      '  Too few closed trades to say anything. A win rate over a handful of',
      '  trades is noise wearing a percentage sign.',
    );
  } else if (bench.verdict === 'LAGGING') {
    lines.push(
      '',
      '  Buy-and-hold is ahead. This is the common outcome for LLM trading',
      '  agents and is the result the system is built to be able to notice.',
    );
  }
  if (conf.length > 0) {
    lines.push('', 'BY AUDITOR CONFIDENCE AT ENTRY');
    for (const b of conf) {
      lines.push(`  ${b.tier.padEnd(10)} ${String(b.trades).padStart(3)} trades  ${pct(b.winRate).padStart(7)}  ${b.realised}`);
    }
    lines.push('  If high confidence does not beat low confidence, the score is decoration.');
  }
  if (src.length > 0) {
    lines.push('', 'BY SOURCE');
    for (const b of src) {
      lines.push(`  ${b.tier.padEnd(10)} ${String(b.trades).padStart(3)} trades  ${pct(b.winRate).padStart(7)}  ${b.realised}`);
    }
  }
  return lines.join('\n');
}

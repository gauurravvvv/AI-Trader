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

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded on purpose: a control benchmark that changes every time you look at it
 * cannot be argued with, and "run it again until it flatters us" is exactly the
 * failure mode a control exists to prevent.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomControl {
  /** Mean return of the random book, as a fraction. */
  meanReturn: number;
  /** Mean return of the real book over the same windows. */
  strategyReturn: number;
  /** Strategy minus random. Negative means coin-flip entries did better. */
  edgeOverRandom: number;
  samples: number;
  verdict: 'BEATS_RANDOM' | 'NO_BETTER_THAN_RANDOM' | 'INSUFFICIENT_DATA';
}

export interface ControlTrade {
  symbol: string;
  openedAt: string;
  closedAt: string;
  /** Realised return of the actual trade, as a fraction. */
  actualReturn: number;
}

/**
 * Compare real entries against random ones over the same windows.
 *
 * This is the control the buy-and-hold benchmark cannot provide. Beating SPY
 * tells you the book made money; beating a random pick from the same universe
 * held for the same days tells you the *selection* did something. A strategy
 * that beats the index because it happened to hold high-beta names in a rally
 * will beat SPY and tie with random, and only the second comparison says so.
 *
 * `draws` repeats each window with different symbols to damp the variance of a
 * single unlucky pick.
 */
export async function randomEntryControl(
  trades: ControlTrade[],
  universe: string[],
  returnFor: (symbol: string, openedAt: string, closedAt: string) => Promise<number | null>,
  opts: { rand?: () => number; draws?: number; minTrades?: number } = {},
): Promise<RandomControl> {
  const rand = opts.rand ?? seededRandom(20260904);
  const draws = opts.draws ?? 5;
  const minTrades = opts.minTrades ?? 20;

  if (trades.length === 0 || universe.length === 0) {
    return {
      meanReturn: 0, strategyReturn: 0, edgeOverRandom: 0, samples: 0,
      verdict: 'INSUFFICIENT_DATA',
    };
  }

  const randomReturns: number[] = [];
  for (const t of trades) {
    for (let d = 0; d < draws; d += 1) {
      const pick = universe[Math.floor(rand() * universe.length)];
      if (pick === undefined) continue;
      const r = await returnFor(pick, t.openedAt, t.closedAt);
      if (r !== null && Number.isFinite(r)) randomReturns.push(r);
    }
  }

  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const meanReturn = mean(randomReturns);
  const strategyReturn = mean(trades.map((t) => t.actualReturn));
  const edgeOverRandom = strategyReturn - meanReturn;

  return {
    meanReturn,
    strategyReturn,
    edgeOverRandom,
    samples: randomReturns.length,
    verdict:
      trades.length < minTrades || randomReturns.length === 0
        ? 'INSUFFICIENT_DATA'
        : edgeOverRandom > 0
          ? 'BEATS_RANDOM'
          : 'NO_BETTER_THAN_RANDOM',
  };
}

export function controlReport(c: RandomControl): string {
  const pct = (n: number): string => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
  const lines = [
    'VERSUS RANDOM ENTRIES',
    `  Our entries:     ${pct(c.strategyReturn)}`,
    `  Random entries:  ${pct(c.meanReturn)}  (${String(c.samples)} draws)`,
    `  Edge:            ${pct(c.edgeOverRandom)}`,
    `  Verdict:         ${c.verdict}`,
  ];
  if (c.verdict === 'NO_BETTER_THAN_RANDOM') {
    lines.push(
      '',
      '  Picking at random from the same universe, held for the same days, did',
      '  as well or better. Whatever the agents are selecting on is not adding',
      '  anything yet. This is the comparison a rising market cannot hide.',
    );
  } else if (c.verdict === 'INSUFFICIENT_DATA') {
    lines.push('', '  Not enough closed trades for the control to mean anything.');
  }
  return lines.join('\n');
}

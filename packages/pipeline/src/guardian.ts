import Decimal from 'decimal.js';
import { BaseAgent } from '@aegis/agents';
import type { Ledger } from '@aegis/ledger';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { OrderRouter } from '@aegis/risk';
import type { PipelineDeps } from './agents.js';

export interface ExitRule {
  /** Fraction below entry that triggers a stop. 0.08 = -8%. */
  stopLossPct: number;
  /** Fraction above entry that takes profit. */
  takeProfitPct: number;
  /** Days to hold before the drift thesis has had its chance. */
  timeStopDays: number;
  /** Once up this much, trail the stop behind the high-water mark. */
  trailActivatePct: number;
  trailDistancePct: number;
}

export const DRIFT_EXIT: ExitRule = {
  // Post-earnings drift plays out over weeks, so the stop is wide enough to
  // survive normal noise and the time stop does most of the work.
  stopLossPct: 0.08,
  takeProfitPct: 0.15,
  timeStopDays: 45,
  trailActivatePct: 0.06,
  trailDistancePct: 0.05,
};

export type ExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'HALT_FLATTEN';

export interface ExitDecision {
  exit: boolean;
  reason: ExitReason | null;
  detail: string;
}

/**
 * Purely mechanical. INV-4 applies here as much as to the Risk Officer: an exit
 * must work when the budget is exhausted, when the model is unreachable, and at
 * three in the morning. No LLM is consulted.
 */
export function evaluateExit(
  entryPrice: string,
  currentPrice: string,
  highWaterMark: string,
  heldDays: number,
  rule: ExitRule = DRIFT_EXIT,
): ExitDecision {
  const entry = new Decimal(entryPrice);
  const now = new Decimal(currentPrice);
  const high = Decimal.max(new Decimal(highWaterMark), now);
  if (entry.lte(0)) return { exit: false, reason: null, detail: 'no entry price' };

  const move = now.minus(entry).div(entry);
  const fromHigh = high.gt(0) ? high.minus(now).div(high) : new Decimal(0);
  const peak = high.minus(entry).div(entry);

  if (move.lte(-rule.stopLossPct)) {
    return {
      exit: true,
      reason: 'STOP_LOSS',
      detail: `${move.times(100).toFixed(2)}% vs stop -${String(rule.stopLossPct * 100)}%`,
    };
  }

  // The trailing stop only arms after the position has actually run. Arming it
  // immediately would just be a tighter stop-loss under a different name.
  if (peak.gte(rule.trailActivatePct) && fromHigh.gte(rule.trailDistancePct)) {
    return {
      exit: true,
      reason: 'TRAILING_STOP',
      detail: `${fromHigh.times(100).toFixed(2)}% off the high of ${high.toFixed(2)}`,
    };
  }

  if (move.gte(rule.takeProfitPct)) {
    return {
      exit: true,
      reason: 'TAKE_PROFIT',
      detail: `+${move.times(100).toFixed(2)}% vs target +${String(rule.takeProfitPct * 100)}%`,
    };
  }

  if (heldDays >= rule.timeStopDays) {
    return {
      exit: true,
      reason: 'TIME_STOP',
      detail: `held ${String(heldDays)}d, drift window is ${String(rule.timeStopDays)}d`,
    };
  }

  return {
    exit: false,
    reason: null,
    detail: `${move.times(100).toFixed(2)}%, ${String(heldDays)}d held`,
  };
}

interface PosRow {
  symbol: string;
  qty: string;
  avg_cost: string;
  opened_at: string | null;
}

/**
 * Watches every open position and closes it when a mechanical rule fires.
 *
 * Runs regardless of budget tier. The Budget Governor can stop us opening new
 * positions; it must never stop us closing one.
 */
export class PositionGuardianAgent extends BaseAgent {
  private readonly highWater = new Map<string, string>();

  constructor(
    private readonly p: PipelineDeps & { ledger: Ledger; prices: YahooPriceSource; router: OrderRouter },
    private readonly rule: ExitRule = DRIFT_EXIT,
  ) {
    super('position-guardian', { intervalMs: 60 * 1000 }, p);
  }

  override shouldRun(): boolean {
    return this.p.ledger.openCount(this.p.router.venue) > 0;
  }

  async execute(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT symbol, qty, avg_cost, opened_at FROM positions
         WHERE venue = ? AND CAST(qty AS REAL) > 0`,
      )
      .all(this.p.router.venue) as PosRow[];

    for (const pos of rows) {
      const quote = await this.p.prices.quote(pos.symbol);
      if (!quote) {
        this.log.warn(this.name, `${pos.symbol}: no quote, cannot evaluate exit`);
        continue;
      }

      const prevHigh = this.highWater.get(pos.symbol) ?? pos.avg_cost;
      const high = Decimal.max(new Decimal(prevHigh), new Decimal(quote.last)).toString();
      this.highWater.set(pos.symbol, high);

      const heldDays =
        pos.opened_at === null
          ? 0
          : Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 86_400_000);

      const d = evaluateExit(pos.avg_cost, quote.last, high, heldDays, this.rule);
      if (!d.exit) {
        this.log.event(this.name, `${pos.symbol}  hold  ${d.detail}`);
        continue;
      }

      this.log.warn(this.name, `${pos.symbol}  ${d.reason ?? ''}  ${d.detail} — exiting`);
      await this.close(pos, quote.last, d.reason ?? 'STOP_LOSS');
    }
  }

  private async close(pos: PosRow, price: string, reason: ExitReason): Promise<void> {
    const ins = this.db
      .prepare(
        `INSERT INTO decisions (symbol, market, venue, side, rationale, status)
         VALUES (?,?,?, 'sell', ?, 'APPROVED')`,
      )
      .run(pos.symbol, 'US', this.p.router.venue, `exit: ${reason}`);
    const decisionId = Number(ins.lastInsertRowid);

    const res = await this.p.router.route(
      { decisionId, symbol: pos.symbol, side: 'sell', qty: pos.qty, price },
      // Liquidity is not a gate on an exit; the Risk Officer permits sells.
      '999999999',
    );
    if (res.ok) {
      this.log.ok('order-router', `${pos.symbol} SELL ${pos.qty} — ${reason}`);
      this.highWater.delete(pos.symbol);
    } else {
      this.log.error('order-router', `${pos.symbol} exit REJECTED: ${res.reason}`);
    }
  }
}

import Decimal from 'decimal.js';
import { BaseAgent } from '@aegis/agents';
import type { Ledger } from '@aegis/ledger';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { OrderRouter } from '@aegis/risk';
import type { PipelineDeps } from './agents.js';
import { evaluateWatch, readConditions, newFilingSince, opposingNewsSince } from './watch.js';

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
  | 'THESIS_BREAK'
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
  /** Best price reached: the high for a long, the low for a short. */
  waterMark: string,
  heldDays: number,
  rule: ExitRule = DRIFT_EXIT,
  direction: 'long' | 'short' = 'long',
): ExitDecision {
  const entry = new Decimal(entryPrice);
  const now = new Decimal(currentPrice);
  if (entry.lte(0)) return { exit: false, reason: null, detail: 'no entry price' };

  // Everything below is expressed as move IN OUR FAVOUR, so one set of rules
  // serves both directions. For a short the stop is above the entry and the
  // water mark is the low — inverting the sign here is what keeps the rest of
  // this function from needing a second copy.
  const sign = direction === 'long' ? 1 : -1;
  const best = direction === 'long'
    ? Decimal.max(new Decimal(waterMark), now)
    : Decimal.min(new Decimal(waterMark), now);

  const move = now.minus(entry).div(entry).times(sign);
  const fromBest = best.gt(0) ? now.minus(best).div(best).times(-sign) : new Decimal(0);
  const peak = best.minus(entry).div(entry).times(sign);
  const fromHigh = fromBest;
  const high = best;

  if (move.lte(-rule.stopLossPct)) {
    return {
      exit: true,
      reason: 'STOP_LOSS',
      detail: `${move.times(100).toFixed(2)}% against us vs stop -${String(rule.stopLossPct * 100)}%`,
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

/** Signed percentage move from entry, formatted for a subject line. */
export function pnlPct(entry: string, exit: string, direction: 'long' | 'short' = 'long'): string {
  const e = new Decimal(entry);
  if (e.lte(0)) return 'n/a';
  // Signed by direction: a short that fell is a gain, and reporting it as a
  // loss would make every winning short look like a losing one.
  const pct = new Decimal(exit).minus(e).div(e).times(100).times(direction === 'long' ? 1 : -1);
  return `${pct.gte(0) ? '+' : ''}${pct.toFixed(2)}%`;
}

function exitBody(
  pos: { symbol: string; qty: string; avg_cost: string; opened_at: string | null },
  price: string,
  reason: ExitReason,
  detail: string,
): string {
  const gross = new Decimal(price).minus(pos.avg_cost).times(pos.qty);
  return [
    `SELL ${pos.qty} ${pos.symbol} @ ~${Number(price).toFixed(2)}`,
    `Entry:     ${Number(pos.avg_cost).toFixed(2)}`,
    `Move:      ${pnlPct(pos.avg_cost, price)}`,
    `Gross P&L: ${gross.toFixed(2)} (before fees; the fill notification carries the net)`,
    `Opened:    ${pos.opened_at ?? 'unknown'}`,
    '',
    `Reason:    ${reason}`,
    detail === '' ? '' : `Detail:    ${detail}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

interface PosRow {
  symbol: string;
  qty: string;
  avg_cost: string;
  opened_at: string | null;
}

interface EntryRow {
  id: number;
  thesis_break: string | null;
}

/**
 * Watches every open position and closes it when a mechanical rule fires.
 *
 * Runs regardless of budget tier. The Budget Governor can stop us opening new
 * positions; it must never stop us closing one.
 */
export class PositionGuardianAgent extends BaseAgent {
  /** Best price reached per symbol: the high for a long, the low for a short. */
  private readonly waterMark = new Map<string, string>();

  constructor(
    private readonly p: PipelineDeps & { ledger: Ledger; prices: YahooPriceSource; router: OrderRouter },
    private readonly rule: ExitRule = DRIFT_EXIT,
  ) {
    // One guardian per venue, so the name carries the book it watches.
    // Two agents called 'position-guardian' are indistinguishable in the log
    // and merge into one row in the per-agent stats.
    super(`guardian:${p.router.venue}`, { intervalMs: 60 * 1000 }, p);
  }

  override shouldRun(): boolean {
    return this.p.ledger.openCount(this.p.router.venue) > 0;
  }

  async execute(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT symbol, qty, avg_cost, opened_at FROM positions
         WHERE venue = ? AND CAST(qty AS REAL) != 0`,
      )
      .all(this.p.router.venue) as PosRow[];

    for (const pos of rows) {
      const quote = await this.p.prices.quote(pos.symbol);
      if (!quote) {
        this.log.warn(this.name, `${pos.symbol}: no quote, cannot evaluate exit`);
        continue;
      }

      const isShort = new Decimal(pos.qty).isNegative();
      const prev = this.waterMark.get(pos.symbol) ?? pos.avg_cost;
      const mark = (isShort
        ? Decimal.min(new Decimal(prev), new Decimal(quote.last))
        : Decimal.max(new Decimal(prev), new Decimal(quote.last))
      ).toString();
      this.waterMark.set(pos.symbol, mark);

      const heldDays =
        pos.opened_at === null
          ? 0
          : Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 86_400_000);

      // The thesis is checked before the price rules. A position whose reason
      // for existing has been falsified should be closed on that basis, not
      // held until it happens to hit a stop.
      const broken = this.checkThesis(pos, quote.last, heldDays);
      if (broken !== null) {
        this.log.warn(this.name, `${pos.symbol}  THESIS_BREAK  ${broken} — exiting`);
        await this.close(pos, quote.last, 'THESIS_BREAK', broken);
        continue;
      }

      const d = evaluateExit(
        pos.avg_cost, quote.last, mark, heldDays, this.rule, isShort ? 'short' : 'long',
      );
      if (!d.exit) {
        this.log.event(this.name, `${pos.symbol}  hold  ${d.detail}`);
        continue;
      }

      this.log.warn(this.name, `${pos.symbol}  ${d.reason ?? ''}  ${d.detail} — exiting`);
      await this.close(pos, quote.last, d.reason ?? 'STOP_LOSS', d.detail);
    }
  }

  /**
   * Evaluate the conditions recorded when the position was opened.
   *
   * Returns the detail of the first condition that fired, or null. Costs one
   * query and no model call, so it runs at every budget tier.
   */
  private checkThesis(pos: PosRow, price: string, heldDays: number): string | null {
    const entry = this.db
      .prepare(
        `SELECT id, thesis_break FROM decisions
          WHERE symbol = ? AND venue = ? AND side = 'buy' AND status = 'EXECUTED'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(pos.symbol, this.p.router.venue) as EntryRow | undefined;
    if (!entry) return null;

    const { conditions, unevaluable } = readConditions(entry.thesis_break);
    if (unevaluable > 0 && conditions.length === 0) {
      // Written before conditions were structured. Say so once rather than
      // reporting "thesis intact" about a thesis nobody can check.
      this.log.event(
        this.name,
        `${pos.symbol}: ${String(unevaluable)} thesis clause(s) are prose and cannot be evaluated`,
      );
      return null;
    }
    if (conditions.length === 0) return null;

    const since = pos.opened_at ?? new Date(0).toISOString();
    const res = evaluateWatch(conditions, {
      price,
      heldDays,
      newFilingSinceEntry: newFilingSince(this.db, pos.symbol, since),
      opposingNewsMateriality: opposingNewsSince(this.db, pos.symbol, since, 'long'),
    });
    return res.broken ? res.detail : null;
  }

  private async close(
    pos: PosRow,
    price: string,
    reason: ExitReason,
    detail = '',
  ): Promise<void> {
    // Closing a short is a buy. Hard-coding 'sell' here would have tried to
    // sell more of a position we were already short.
    const isShort = new Decimal(pos.qty).isNegative();
    const side = isShort ? 'buy' : 'sell';
    const qty = new Decimal(pos.qty).abs().toString();

    const ins = this.db
      .prepare(
        `INSERT INTO decisions (symbol, market, venue, side, rationale, status)
         VALUES (?,?,?,?,?, 'APPROVED')`,
      )
      .run(pos.symbol, 'US', this.p.router.venue, side, `exit: ${reason}`);
    const decisionId = Number(ins.lastInsertRowid);

    const res = await this.p.router.route(
      { decisionId, symbol: pos.symbol, side, qty, price, intent: 'close' },
      // Liquidity is not a gate on an exit; the Risk Officer permits sells.
      '999999999',
    );
    if (res.ok) {
      this.log.ok('order-router', `${pos.symbol} ${side.toUpperCase()} ${qty} — ${reason}`);
      this.waterMark.delete(pos.symbol);
      this.p.notify?.({
        kind: 'POSITION_EXITED',
        subject: `Aegis: exited ${pos.symbol} — ${reason} (${pnlPct(pos.avg_cost, price, isShort ? 'short' : 'long')})`,
        body: exitBody(pos, price, reason, detail),
      });
    } else {
      this.log.error('order-router', `${pos.symbol} exit REJECTED: ${res.reason}`);
      this.p.notify?.({
        kind: 'ORDER_REJECTED',
        subject: `Aegis: EXIT REFUSED for ${pos.symbol} — ${res.reason}`,
        body:
          `An exit for ${pos.qty} ${pos.symbol} (${reason}) was refused: ${res.reason}.\n` +
          'The position is still open and still at risk. This needs a human.',
      });
    }
  }
}

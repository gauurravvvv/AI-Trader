import Decimal from 'decimal.js';
import { BaseAgent } from '@aegis/agents';
import type { Db } from '@aegis/db';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { OrderRouter } from '@aegis/risk';
import type { PipelineDeps } from './agents.js';

export interface Rung {
  index: number;
  qty: string;
  /** Refuse this rung if the price has run above it (below, for a sell). */
  maxPrice: string;
}

export interface EntryPlan {
  rungs: Rung[];
  /** Why this shape — recorded so a plan can be argued with later. */
  rationale: string;
}

/**
 * Split a target size into rungs.
 *
 * Conviction decides the shape. A high-conviction entry takes most of the size
 * immediately, because waiting costs more than it saves when the read is
 * strong. A marginal one leads with a small probe and adds only if the market
 * does not immediately disagree — which is also the case where being wrong is
 * most likely, so buying the rest of it at a worse price is the outcome to
 * avoid.
 *
 * Each rung carries a price ceiling. A ladder without one is just a slower way
 * to buy a breakout at the top.
 */
export function planEntry(
  totalQty: string,
  price: string,
  conviction: number,
  opts: { maxRungs?: number; bandPct?: number } = {},
): EntryPlan {
  const total = new Decimal(totalQty);
  const p = new Decimal(price);
  if (total.lte(0) || p.lte(0)) {
    return { rungs: [], rationale: 'nothing to place' };
  }

  const maxRungs = opts.maxRungs ?? 3;
  // How far above entry we are still willing to add. Wider for high conviction:
  // a strong read tolerates chasing a little; a weak one does not.
  const band = opts.bandPct ?? 0.02;

  // Weights by conviction. They always sum to 1 and always lead with the
  // largest rung — averaging *up* into a position is how a small mistake
  // becomes a large one.
  let weights: number[];
  let rationale: string;
  if (conviction >= 85) {
    weights = [0.7, 0.3];
    rationale = 'high conviction: most of the size now, one add';
  } else if (conviction >= 70) {
    weights = [0.5, 0.3, 0.2];
    rationale = 'moderate conviction: probe, confirm, complete';
  } else {
    weights = [0.4, 0.3, 0.3];
    rationale = 'low conviction: small probe, add only if it holds';
  }
  weights = weights.slice(0, maxRungs);

  const rungs: Rung[] = [];
  let placed = new Decimal(0);
  weights.forEach((w, i) => {
    const isLast = i === weights.length - 1;
    // The last rung takes the remainder so rounding never loses or invents size.
    const qty = isLast ? total.minus(placed) : total.times(w).floor();
    if (qty.lte(0)) return;
    placed = placed.plus(qty);
    rungs.push({
      index: i,
      qty: qty.toString(),
      maxPrice: p.times(1 + band * i).toFixed(2),
    });
  });

  return { rungs, rationale };
}

export interface PlanRow {
  id: number;
  decision_id: number;
  venue: string;
  symbol: string;
  side: string;
  rungs: string;
  placed_rungs: string;
  status: string;
}

export function savePlan(
  db: Db,
  decisionId: number,
  venue: string,
  symbol: string,
  side: string,
  plan: EntryPlan,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO execution_plans (decision_id, venue, symbol, side, rungs)
     VALUES (?,?,?,?,?)`,
  ).run(decisionId, venue, symbol, side, JSON.stringify(plan.rungs));
}

/** Record that a rung was sent outside the ladder agent's own tick. */
export function markRungPlaced(db: Db, decisionId: number, index: number): void {
  const row = db
    .prepare('SELECT rungs, placed_rungs FROM execution_plans WHERE decision_id = ?')
    .get(decisionId) as { rungs: string; placed_rungs: string } | undefined;
  if (!row) return;
  const placed = [...new Set([...(JSON.parse(row.placed_rungs) as number[]), index])];
  const total = (JSON.parse(row.rungs) as Rung[]).length;
  db.prepare(
    `UPDATE execution_plans SET placed_rungs = ?, status = ?, updated_at = datetime('now')
      WHERE decision_id = ?`,
  ).run(JSON.stringify(placed), placed.length >= total ? 'COMPLETE' : 'ACTIVE', decisionId);
}

export function abandonPlan(db: Db, decisionId: number, reason: string): void {
  db.prepare(
    `UPDATE execution_plans SET status = 'ABANDONED', abandon_reason = ?, updated_at = datetime('now')
      WHERE decision_id = ?`,
  ).run(reason, decisionId);
}

export function activePlans(db: Db, venue: string): PlanRow[] {
  return db
    .prepare(`SELECT * FROM execution_plans WHERE status = 'ACTIVE' AND venue = ?`)
    .all(venue) as PlanRow[];
}

/** The next rung that has not been sent, or null when the plan is finished. */
export function nextRung(plan: PlanRow): Rung | null {
  const rungs = JSON.parse(plan.rungs) as Rung[];
  const placed = new Set(JSON.parse(plan.placed_rungs) as number[]);
  return rungs.find((r) => !placed.has(r.index)) ?? null;
}

/**
 * Walks active plans, placing at most one rung per plan per tick.
 *
 * One per tick on purpose: the point of a ladder is to let time pass between
 * fills so the market can disagree. Placing every rung in the same second is
 * indistinguishable from sending the whole order at once, and inherits all of
 * its slippage.
 */
export class EntryLadderAgent extends BaseAgent {
  constructor(
    private readonly p: PipelineDeps & { prices: YahooPriceSource; router: OrderRouter },
  ) {
    super(`ladder:${p.router.venue}`, { intervalMs: 90 * 1000 }, p);
  }

  override shouldRun(): boolean {
    return activePlans(this.db, this.p.router.venue).length > 0;
  }

  async execute(): Promise<void> {
    for (const plan of activePlans(this.db, this.p.router.venue)) {
      const rung = nextRung(plan);
      if (rung === null) {
        this.finish(plan.id, 'COMPLETE', null);
        this.log.ok(this.name, `${plan.symbol}: ladder complete`);
        continue;
      }

      const quote = await this.p.prices.quote(plan.symbol);
      if (!quote) {
        this.log.warn(this.name, `${plan.symbol}: no quote, holding the ladder`);
        continue;
      }

      if (new Decimal(quote.last).gt(rung.maxPrice)) {
        // The price ran past the band this plan was built for. Abandoning the
        // remainder is the plan working, not failing.
        this.finish(plan.id, 'ABANDONED', `price ${quote.last} above rung ceiling ${rung.maxPrice}`);
        this.log.warn(
          this.name,
          `${plan.symbol}: abandoning rung ${String(rung.index)} — ${quote.last} above ${rung.maxPrice}`,
        );
        continue;
      }

      const res = await this.p.router.route(
        {
          decisionId: plan.decision_id,
          rungIndex: rung.index,
          symbol: plan.symbol,
          side: plan.side === 'sell' ? 'sell' : 'buy',
          qty: rung.qty,
          price: quote.last,
          allowResize: true,
        },
        await this.adv(plan.symbol),
      );

      if (res.ok) {
        this.markPlaced(plan, rung.index);
        this.log.ok(
          this.name,
          `${plan.symbol}: rung ${String(rung.index)} placed, ${rung.qty} @ ~${Number(quote.last).toFixed(2)}`,
        );
      } else {
        this.finish(plan.id, 'ABANDONED', res.reason);
        this.log.warn(this.name, `${plan.symbol}: rung ${String(rung.index)} refused (${res.reason})`);
      }
    }
  }

  private async adv(symbol: string): Promise<string | null> {
    const bars = await this.p.prices.bars(symbol, 30);
    return bars.length >= 5
      ? String(Math.round(bars.reduce((a, b) => a + b.v, 0) / bars.length))
      : null;
  }

  private markPlaced(plan: PlanRow, index: number): void {
    const placed = [...new Set([...(JSON.parse(plan.placed_rungs) as number[]), index])];
    const total = (JSON.parse(plan.rungs) as Rung[]).length;
    this.db
      .prepare(
        `UPDATE execution_plans
            SET placed_rungs = ?, status = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(JSON.stringify(placed), placed.length >= total ? 'COMPLETE' : 'ACTIVE', plan.id);
  }

  private finish(id: number, status: 'COMPLETE' | 'ABANDONED', reason: string | null): void {
    this.db
      .prepare(
        `UPDATE execution_plans SET status = ?, abandon_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(status, reason, id);
  }
}

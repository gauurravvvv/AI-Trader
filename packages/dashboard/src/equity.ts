import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';

export interface EquityPoint {
  /** ISO timestamp of the fill that moved the curve. */
  at: string;
  /** Cumulative realised P&L after this fill. */
  equity: number;
  /** Distance below the running peak, as a positive number. */
  drawdown: number;
  symbol: string;
  side: string;
  price: number;
  qty: number;
}

/**
 * The realised equity curve, one point per fill.
 *
 * Realised only. Marking open positions to market would make the curve move
 * when nothing was decided, and the question this chart answers is what the
 * decisions did — not what the market did to them while they were held.
 *
 * The TradingView widgets on this page cannot draw this: they ship their own
 * data and have no idea what we filled. That is why there are two chart systems
 * rather than one, and why this one is hand-drawn SVG — a charting library from
 * a CDN would add a runtime dependency that fails offline, for a line, a shaded
 * region and some dots.
 */
export function equityCurve(db: Db, venue?: string, limit = 500): EquityPoint[] {
  const rows = db
    .prepare(
      `SELECT f.filled_at, f.qty, f.price, o.symbol, o.side, o.venue
         FROM fills f JOIN orders o ON o.id = f.order_id
        ${venue === undefined ? '' : 'WHERE o.venue = ?'}
        ORDER BY f.filled_at ASC, f.id ASC
        LIMIT ?`,
    )
    .all(...(venue === undefined ? [limit] : [venue, limit])) as {
    filled_at: string;
    qty: string;
    price: string;
    symbol: string;
    side: string;
    venue: string;
  }[];

  // Average cost per symbol, so a sell can be scored against what it cost.
  const held = new Map<string, { qty: Decimal; cost: Decimal }>();
  let realised = new Decimal(0);
  let peak = new Decimal(0);
  const out: EquityPoint[] = [];

  for (const r of rows) {
    const qty = new Decimal(r.qty);
    const price = new Decimal(r.price);
    const pos = held.get(r.symbol) ?? { qty: new Decimal(0), cost: new Decimal(0) };

    if (r.side === 'buy') {
      const totalCost = pos.cost.times(pos.qty).plus(price.times(qty));
      const totalQty = pos.qty.plus(qty);
      held.set(r.symbol, {
        qty: totalQty,
        cost: totalQty.gt(0) ? totalCost.div(totalQty) : new Decimal(0),
      });
    } else {
      const closed = Decimal.min(qty, pos.qty);
      realised = realised.plus(price.minus(pos.cost).times(closed));
      held.set(r.symbol, { qty: pos.qty.minus(closed), cost: pos.cost });
    }

    if (realised.gt(peak)) peak = realised;
    out.push({
      at: r.filled_at,
      equity: realised.toNumber(),
      drawdown: peak.minus(realised).toNumber(),
      symbol: r.symbol,
      side: r.side,
      price: price.toNumber(),
      qty: qty.toNumber(),
    });
  }
  return out;
}

import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';
import type { FillEvent, VenuePosition } from '@aegis/brokers';

export interface Lot {
  id: number;
  remainingQty: string;
  costBasis: string;
  acquiredAt: string;
}

export interface LedgerPosition {
  venue: string;
  symbol: string;
  qty: string;
  avgCost: string;
  realisedPnl: string;
  closedAt: string | null;
  lots: Lot[];
}

interface PosRow {
  id: number;
  venue: string;
  symbol: string;
  qty: string;
  avg_cost: string;
  realised_pnl: string;
  closed_at: string | null;
}

interface LotRow {
  id: number;
  remaining_qty: string;
  cost_basis: string;
  acquired_at: string;
}

/**
 * Lot-level position accounting.
 *
 * Sells consume the HIGHEST-COST lot first. That is what makes a trim lower the
 * blended average rather than raise it — the whole mechanic the position-ladder
 * strategy depends on. FIFO would do the opposite on a position built by
 * averaging down.
 */
export class Ledger {
  constructor(private readonly db: Db) {}

  /** Idempotent on venueFillId — the same websocket event can arrive twice. */
  applyFill(fill: FillEvent, orderId: number, venue: string): void {
    this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO fills (order_id, venue_fill_id, qty, price, fee, filled_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(orderId, fill.venueFillId, fill.qty, fill.price, fill.fee, fill.filledAt);
      if (inserted.changes === 0) return; // already applied

      const fillId = Number(inserted.lastInsertRowid);

      let pos = this.db
        .prepare('SELECT * FROM positions WHERE venue = ? AND symbol = ?')
        .get(venue, fill.symbol) as PosRow | undefined;

      if (!pos) {
        const r = this.db
          .prepare('INSERT INTO positions (venue, symbol, opened_at) VALUES (?,?,?)')
          .run(venue, fill.symbol, fill.filledAt);
        pos = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(r.lastInsertRowid) as PosRow;
      }

      // Signed throughout. A lot's remaining_qty is positive for a long and
      // negative for a short, and every rule below is the same in both
      // directions — which is the only way to avoid a second, subtly different
      // copy of this logic for shorts.
      const signed = fill.side === 'buy' ? new Decimal(fill.qty) : new Decimal(fill.qty).negated();
      const held = new Decimal(pos.qty);
      const extending = held.isZero() || held.s === signed.s;

      if (extending) {
        this.db
          .prepare(
            `INSERT INTO lots (position_id, fill_id, original_qty, remaining_qty, cost_basis, acquired_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(pos.id, fillId, signed.toString(), signed.toString(), fill.price, fill.filledAt);

        const newQty = held.plus(signed);
        const newAvg = newQty.isZero()
          ? new Decimal(0)
          : held.times(pos.avg_cost).plus(signed.times(fill.price)).div(newQty);
        this.db
          .prepare('UPDATE positions SET qty = ?, avg_cost = ?, closed_at = NULL WHERE id = ?')
          .run(newQty.toString(), newAvg.toFixed(10), pos.id);
        return;
      }

      // Reducing. Consume lots worst-first in whichever direction we are:
      // trimming a long sheds its highest-cost shares, covering a short sheds
      // the ones sold cheapest. Both leave the better half of the position.
      let remaining = signed.abs();
      let realised = new Decimal(pos.realised_pnl);
      const lots = this.db
        .prepare(
          `SELECT * FROM lots WHERE position_id = ?
            ORDER BY CAST(cost_basis AS REAL) ${held.isPositive() ? 'DESC' : 'ASC'}`,
        )
        .all(pos.id) as LotRow[];

      for (const lot of lots) {
        if (remaining.lte(0)) break;
        const avail = new Decimal(lot.remaining_qty);
        if (avail.isZero()) continue;
        // Only lots on the side we are reducing.
        if (avail.s !== held.s) continue;
        const take = Decimal.min(avail.abs(), remaining);
        // sign(lot) makes this correct for both: a long realises price - cost,
        // a short realises cost - price.
        realised = realised.plus(
          take.times(new Decimal(fill.price).minus(lot.cost_basis)).times(avail.s),
        );
        this.db
          .prepare('UPDATE lots SET remaining_qty = ? WHERE id = ?')
          .run(avail.minus(take.times(avail.s)).toString(), lot.id);
        remaining = remaining.minus(take);
      }

      const newQty = held.plus(signed);

      // Crossed through flat: whatever is left is a new position in the other
      // direction, opened at this price, not a remnant of the old one.
      if (remaining.gt(0) && !newQty.isZero()) {
        this.db
          .prepare(
            `INSERT INTO lots (position_id, fill_id, original_qty, remaining_qty, cost_basis, acquired_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(pos.id, fillId, newQty.toString(), newQty.toString(), fill.price, fill.filledAt);
      }

      const survivors = (
        this.db.prepare('SELECT * FROM lots WHERE position_id = ?').all(pos.id) as LotRow[]
      ).filter((l) => !new Decimal(l.remaining_qty).isZero());

      const totalQty = survivors.reduce((a, l) => a.plus(l.remaining_qty), new Decimal(0));
      const newAvg = totalQty.isZero()
        ? new Decimal(0)
        : survivors
            .reduce((a, l) => a.plus(new Decimal(l.remaining_qty).times(l.cost_basis)), new Decimal(0))
            .div(totalQty);

      this.db
        .prepare(
          'UPDATE positions SET qty = ?, avg_cost = ?, realised_pnl = ?, closed_at = ? WHERE id = ?',
        )
        .run(
          newQty.toString(),
          newAvg.toFixed(10),
          realised.toFixed(10),
          newQty.isZero() ? fill.filledAt : null,
          pos.id,
        );
    })();
  }

  get(venue: string, symbol: string): LedgerPosition | null {
    const pos = this.db
      .prepare('SELECT * FROM positions WHERE venue = ? AND symbol = ?')
      .get(venue, symbol) as PosRow | undefined;
    if (!pos) return null;

    const lots = (
      this.db.prepare('SELECT * FROM lots WHERE position_id = ?').all(pos.id) as LotRow[]
    )
      .filter((l) => new Decimal(l.remaining_qty).gt(0))
      .map((l) => ({
        id: l.id,
        remainingQty: l.remaining_qty,
        costBasis: l.cost_basis,
        acquiredAt: l.acquired_at,
      }));

    return {
      venue: pos.venue,
      symbol: pos.symbol,
      qty: pos.qty,
      avgCost: pos.avg_cost,
      realisedPnl: pos.realised_pnl,
      closedAt: pos.closed_at,
      lots,
    };
  }

  open(venue: string): VenuePosition[] {
    const rows = this.db
      .prepare(// != 0, not > 0: a short is an open position and hiding it here would
      // make the reconciler report a phantom break on every one.
      'SELECT * FROM positions WHERE venue = ? AND CAST(qty AS REAL) != 0')
      .all(venue) as PosRow[];
    return rows.map((p) => ({ symbol: p.symbol, qty: p.qty, avgCost: p.avg_cost }));
  }

  openCount(venue: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) c FROM positions WHERE venue = ? AND CAST(qty AS REAL) != 0')
      .get(venue) as { c: number };
    return r.c;
  }

  /** Realised P&L across all closed and partially-closed positions today. */
  realisedToday(venue: string): string {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(CAST(realised_pnl AS REAL)), 0) s FROM positions
         WHERE venue = ? AND date(COALESCE(closed_at, opened_at)) = date('now')`,
      )
      .get(venue) as { s: number };
    return String(r.s);
  }
}

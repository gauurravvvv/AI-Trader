import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { equityCurve } from './equity.js';

let db: Db;
let seq = 0;

function fill(symbol: string, side: 'buy' | 'sell', qty: string, price: string, at: string, venue = 'sim-us'): void {
  seq += 1;
  const d = db.prepare(
    `INSERT INTO decisions (symbol, market, venue, side, status) VALUES (?, 'US', ?, ?, 'EXECUTED')`,
  ).run(symbol, venue, side);
  const o = db.prepare(
    `INSERT INTO orders (decision_id, rung_index, venue, client_order_id, symbol, side, type, qty, status)
     VALUES (?,0,?,?,?,?, 'market', ?, 'filled')`,
  ).run(d.lastInsertRowid, venue, `c${String(seq)}`, symbol, side, qty);
  db.prepare(
    `INSERT INTO fills (order_id, venue_fill_id, qty, price, fee, filled_at) VALUES (?,?,?,?, '0', ?)`,
  ).run(o.lastInsertRowid, `f${String(seq)}`, qty, price, at);
}

beforeEach(() => { db = openDb(':memory:'); seq = 0; });

describe('equityCurve', () => {
  it('is empty before the first fill', () => {
    expect(equityCurve(db)).toEqual([]);
  });

  it('stays flat on a buy — nothing is realised until it is sold', () => {
    fill('NVDA', 'buy', '10', '100', '2026-09-01T14:00:00Z');
    const c = equityCurve(db);
    expect(c).toHaveLength(1);
    expect(c[0]!.equity).toBe(0);
  });

  it('books the gain on the sell', () => {
    fill('NVDA', 'buy', '10', '100', '2026-09-01T14:00:00Z');
    fill('NVDA', 'sell', '10', '125', '2026-09-02T14:00:00Z');
    expect(equityCurve(db).at(-1)!.equity).toBe(250);
  });

  it('scores a partial exit against the average cost, not the last price', () => {
    fill('NVDA', 'buy', '10', '100', '2026-09-01T14:00:00Z');
    fill('NVDA', 'buy', '10', '120', '2026-09-01T15:00:00Z');   // avg 110
    fill('NVDA', 'sell', '10', '130', '2026-09-02T14:00:00Z');
    expect(equityCurve(db).at(-1)!.equity).toBe(200);
  });

  it('tracks drawdown from the running peak, not from zero', () => {
    fill('A', 'buy', '1', '100', '2026-09-01T10:00:00Z');
    fill('A', 'sell', '1', '200', '2026-09-01T11:00:00Z');      // +100, peak 100
    fill('B', 'buy', '1', '100', '2026-09-02T10:00:00Z');
    fill('B', 'sell', '1', '60', '2026-09-02T11:00:00Z');       // -40, equity 60
    const c = equityCurve(db);
    expect(c.at(-1)!.equity).toBe(60);
    expect(c.at(-1)!.drawdown).toBe(40);
  });

  it('reports no drawdown while the curve keeps making highs', () => {
    fill('A', 'buy', '1', '100', '2026-09-01T10:00:00Z');
    fill('A', 'sell', '1', '150', '2026-09-01T11:00:00Z');
    expect(equityCurve(db).every((p) => p.drawdown === 0)).toBe(true);
  });

  it('keeps symbols separate', () => {
    fill('A', 'buy', '1', '100', '2026-09-01T10:00:00Z');
    fill('B', 'buy', '1', '500', '2026-09-01T10:30:00Z');
    fill('A', 'sell', '1', '110', '2026-09-01T11:00:00Z');
    // Selling A must not be scored against B's cost.
    expect(equityCurve(db).at(-1)!.equity).toBe(10);
  });

  it('ignores a sell with nothing held rather than inventing a short', () => {
    fill('A', 'sell', '1', '100', '2026-09-01T10:00:00Z');
    expect(equityCurve(db).at(-1)!.equity).toBe(0);
  });

  it('scopes to a venue when asked', () => {
    fill('A', 'buy', '1', '100', '2026-09-01T10:00:00Z', 'sim-us');
    fill('A', 'sell', '1', '150', '2026-09-01T11:00:00Z', 'sim-us');
    expect(equityCurve(db, 'sim-crypto')).toHaveLength(0);
    expect(equityCurve(db, 'sim-us')).toHaveLength(2);
  });

  it('orders points by fill time so the line cannot go backwards', () => {
    fill('A', 'buy', '1', '100', '2026-09-03T10:00:00Z');
    fill('B', 'buy', '1', '100', '2026-09-01T10:00:00Z');
    const at = equityCurve(db).map((p) => p.at);
    expect([...at].sort()).toEqual(at);
  });

  it('carries what each dot needs to be hovered', () => {
    fill('NVDA', 'buy', '10', '100', '2026-09-01T14:00:00Z');
    const p = equityCurve(db)[0]!;
    expect(p).toMatchObject({ symbol: 'NVDA', side: 'buy', price: 100, qty: 10 });
  });
});

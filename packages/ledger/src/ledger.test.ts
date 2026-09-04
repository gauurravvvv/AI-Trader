import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import type { FillEvent } from '@aegis/brokers';
import { Ledger } from './ledger.js';
import { Reconciler } from './reconciler.js';

const VENUE = 'alpaca-paper';
let db: Db;
let ledger: Ledger;
let orderId: number;
let seq = 0;

beforeEach(() => {
  db = openDb(':memory:');
  ledger = new Ledger(db);
  seq = 0;
  const d = db
    .prepare(
      `INSERT INTO decisions (symbol, market, venue, side) VALUES ('X','US',?, 'buy')`,
    )
    .run(VENUE);
  const o = db
    .prepare(
      `INSERT INTO orders (decision_id, venue, client_order_id, symbol, side, type, qty)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(Number(d.lastInsertRowid), VENUE, 'c:0', 'X', 'buy', 'market', '1');
  orderId = Number(o.lastInsertRowid);
});

function fill(over: Partial<FillEvent> = {}): FillEvent {
  seq += 1;
  return {
    venueOrderId: `vo-${String(seq)}`,
    venueFillId: `vf-${String(seq)}`,
    clientOrderId: 'c:0',
    symbol: 'X',
    side: 'buy',
    qty: '1',
    price: '100',
    fee: '0',
    filledAt: new Date().toISOString(),
    ...over,
  };
}

describe('Ledger', () => {
  it('opens a position from the first buy', () => {
    ledger.applyFill(fill({ qty: '2', price: '100' }), orderId, VENUE);
    const p = ledger.get(VENUE, 'X')!;
    expect(p.qty).toBe('2');
    expect(Number(p.avgCost)).toBeCloseTo(100, 6);
    expect(p.lots).toHaveLength(1);
  });

  it('blends average cost across two buys', () => {
    ledger.applyFill(fill({ qty: '1', price: '100' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '200' }), orderId, VENUE);
    const p = ledger.get(VENUE, 'X')!;
    expect(p.qty).toBe('2');
    expect(Number(p.avgCost)).toBeCloseTo(150, 6);
  });

  it('sells the HIGHEST-cost lot first, so a trim lowers the average', () => {
    ledger.applyFill(fill({ qty: '1', price: '100' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '300' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '250', side: 'sell' }), orderId, VENUE);
    const p = ledger.get(VENUE, 'X')!;
    expect(p.qty).toBe('1');
    // the $300 lot went, not the $100 one — FIFO would have left avg at 300
    expect(Number(p.avgCost)).toBeCloseTo(100, 6);
    expect(Number(p.realisedPnl)).toBeCloseTo(-50, 6);
  });

  it('is idempotent — replaying the same venueFillId changes nothing', () => {
    const f = fill({ qty: '1', price: '100' });
    ledger.applyFill(f, orderId, VENUE);
    ledger.applyFill(f, orderId, VENUE);
    expect(ledger.get(VENUE, 'X')!.qty).toBe('1');
  });

  it('closes the position when quantity reaches zero', () => {
    ledger.applyFill(fill({ qty: '1', price: '100' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '120', side: 'sell' }), orderId, VENUE);
    const p = ledger.get(VENUE, 'X')!;
    expect(p.qty).toBe('0');
    expect(Number(p.realisedPnl)).toBeCloseTo(20, 6);
    expect(p.closedAt).not.toBeNull();
  });

  it('reopens a closed position on a later buy', () => {
    ledger.applyFill(fill({ qty: '1', price: '100' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '120', side: 'sell' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '110' }), orderId, VENUE);
    const p = ledger.get(VENUE, 'X')!;
    expect(p.qty).toBe('1');
    expect(p.closedAt).toBeNull();
  });

  it('counts open positions per venue', () => {
    ledger.applyFill(fill({ qty: '1', symbol: 'X' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', symbol: 'Y' }), orderId, VENUE);
    expect(ledger.openCount(VENUE)).toBe(2);
    expect(ledger.openCount('india-sim')).toBe(0);
  });

  it('drops fully-consumed lots from the position view', () => {
    ledger.applyFill(fill({ qty: '1', price: '100' }), orderId, VENUE);
    ledger.applyFill(fill({ qty: '1', price: '100', side: 'sell' }), orderId, VENUE);
    expect(ledger.get(VENUE, 'X')!.lots).toHaveLength(0);
  });
});

describe('Reconciler', () => {
  const stubAdapter = (venuePositions: { symbol: string; qty: string }[]) =>
    ({
      venue: VENUE,
      reconcile: async (led: { symbol: string; qty: string }[]) => {
        const by = new Map(venuePositions.map((p) => [p.symbol, p.qty]));
        const breaks = led
          .filter((l) => (by.get(l.symbol) ?? '0') !== l.qty)
          .map((l) => ({ symbol: l.symbol, ledgerQty: l.qty, venueQty: by.get(l.symbol) ?? '0' }));
        return { matched: breaks.length === 0, breaks };
      },
    }) as never;

  it('reports matched when ledger and venue agree', async () => {
    ledger.applyFill(fill({ qty: '5' }), orderId, VENUE);
    const r = new Reconciler(ledger, stubAdapter([{ symbol: 'X', qty: '5' }]), db);
    expect((await r.runOnce()).matched).toBe(true);
  });

  it('fires onBreak and persists when they disagree', async () => {
    ledger.applyFill(fill({ qty: '5' }), orderId, VENUE);
    const r = new Reconciler(ledger, stubAdapter([{ symbol: 'X', qty: '3' }]), db);
    let fired = 0;
    r.onBreak(() => {
      fired += 1;
    });
    const report = await r.runOnce();
    expect(report.matched).toBe(false);
    expect(fired).toBe(1);
    const rows = db.prepare('SELECT * FROM reconciliations').all();
    expect(rows).toHaveLength(1);
  });

  it('persists every run, matched or not', async () => {
    const r = new Reconciler(ledger, stubAdapter([]), db);
    await r.runOnce();
    await r.runOnce();
    expect(db.prepare('SELECT COUNT(*) c FROM reconciliations').get()).toEqual({ c: 2 });
  });
});

describe('short positions', () => {
  const at = new Date().toISOString();
  let n = 0;

  function apply(side: 'buy' | 'sell', qty: string, price: string): void {
    n += 1;
    const d = db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side, status) VALUES ('X','US','v',?, 'EXECUTED')`,
    ).run(side);
    const o = db.prepare(
      `INSERT INTO orders (decision_id, rung_index, venue, client_order_id, symbol, side, type, qty, status)
       VALUES (?,0,'v',?, 'X', ?, 'market', ?, 'filled')`,
    ).run(d.lastInsertRowid, `c${String(n)}`, side, qty);
    ledger.applyFill(
      {
        clientOrderId: `c${String(n)}`, venueOrderId: `v${String(n)}`, venueFillId: `f${String(n)}`,
        symbol: 'X', side, qty, price, fee: '0', filledAt: at,
      },
      Number(o.lastInsertRowid),
      'v',
    );
  }

  it('opens a short as a negative position', () => {
    apply('sell', '10', '100');
    expect(ledger.get('v', 'X')!.qty).toBe('-10');
  });

  it('realises a gain when a short is covered lower', () => {
    apply('sell', '10', '100');
    apply('buy', '10', '90');
    // Sold at 100, bought back at 90: +100.
    expect(Number(ledger.get('v', 'X')!.realisedPnl)).toBeCloseTo(100, 6);
  });

  it('realises a loss when a short is covered higher', () => {
    apply('sell', '10', '100');
    apply('buy', '10', '112');
    expect(Number(ledger.get('v', 'X')!.realisedPnl)).toBeCloseTo(-120, 6);
  });

  it('averages two shorts opened at different prices', () => {
    apply('sell', '10', '100');
    apply('sell', '10', '120');
    const p = ledger.get('v', 'X')!;
    expect(p.qty).toBe('-20');
    expect(Number(p.avgCost)).toBeCloseTo(110, 6);
  });

  it('covers the cheapest-sold lot first, leaving the better half of the short', () => {
    apply('sell', '10', '100');
    apply('sell', '10', '140');
    apply('buy', '10', '110');
    // The lot sold at 100 is consumed: -100 realised, and the survivor
    // averages 140 rather than 100.
    const p = ledger.get('v', 'X')!;
    expect(Number(p.realisedPnl)).toBeCloseTo(-100, 6);
    expect(Number(p.avgCost)).toBeCloseTo(140, 6);
  });

  it('closes a short flat rather than leaving a residual', () => {
    apply('sell', '10', '100');
    apply('buy', '10', '95');
    expect(ledger.get('v', 'X')!.qty).toBe('0');
  });

  it('re-bases when a trade crosses from long through flat into short', () => {
    apply('buy', '10', '100');
    apply('sell', '30', '120');
    const p = ledger.get('v', 'X')!;
    expect(p.qty).toBe('-20');
    // The long realised +200; the residual short is at today's price, not 100.
    expect(Number(p.realisedPnl)).toBeCloseTo(200, 6);
    expect(Number(p.avgCost)).toBeCloseTo(120, 6);
  });

  it('counts a short as an open position', () => {
    apply('sell', '10', '100');
    expect(ledger.openCount('v')).toBe(1);
    expect(ledger.open('v')).toHaveLength(1);
  });
});

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

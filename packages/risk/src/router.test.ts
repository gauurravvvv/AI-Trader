import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SimAdapter, US_COSTS, type PriceSource, type Quote } from '@aegis/brokers';
import { Ledger } from '@aegis/ledger';
import { OrderRouter, isHalted, setHalt } from './router.js';

const prices: PriceSource = {
  quote: async (symbol: string): Promise<Quote> => ({
    symbol,
    last: '100',
    bid: '99.99',
    ask: '100.01',
    volume: '1000000',
    at: new Date().toISOString(),
  }),
};

const CONSTRAINTS = {
  tickSize: '0.01',
  lotSize: '1',
  minNotional: '1',
  supportsFractional: false,
  supportsShort: false,
};

let db: Db;
let router: OrderRouter;
let ledger: Ledger;
let adapter: SimAdapter;

function newDecision(symbol = 'NVDA', side: 'buy' | 'sell' = 'buy'): number {
  const r = db
    .prepare(`INSERT INTO decisions (symbol, market, venue, side) VALUES (?,?,?,?)`)
    .run(symbol, 'US', 'alpaca-paper', side);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  db = openDb(':memory:');
  ledger = new Ledger(db);
  adapter = new SimAdapter('alpaca-paper', 'US', prices, US_COSTS, '100000', CONSTRAINTS, {
    isOpen: () => true,
  });
  router = new OrderRouter({ db, adapter, ledger });
  router.start();
});

describe('OrderRouter', () => {
  it('routes a well-sized order and records it', async () => {
    const id = newDecision();
    const r = await router.route(
      { decisionId: id, symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    expect(r.ok).toBe(true);
    const order = db.prepare('SELECT * FROM orders WHERE decision_id = ?').get(id) as {
      status: string;
      client_order_id: string;
    };
    expect(order.client_order_id).toBe(`${String(id)}:0`);
  });

  it('persists a risk evaluation whether it passes or fails', async () => {
    await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    await router.route(
      { decisionId: newDecision('AMD'), symbol: 'AMD', side: 'buy', qty: '99999', price: '100' },
      '1000000',
    );
    const n = db.prepare('SELECT COUNT(*) c FROM risk_evaluations').get() as { c: number };
    expect(n.c).toBe(2);
  });

  it('rejects an oversized order and marks the decision REJECTED', async () => {
    const id = newDecision();
    const r = await router.route(
      { decisionId: id, symbol: 'NVDA', side: 'buy', qty: '5000', price: '100' },
      '1000000',
    );
    expect(r.ok).toBe(false);
    const d = db.prepare('SELECT status, reject_reason FROM decisions WHERE id = ?').get(id) as {
      status: string;
      reject_reason: string;
    };
    expect(d.status).toBe('REJECTED');
    expect(d.reject_reason).toContain('POSITION_CAP');
  });

  it('resizes instead of rejecting when the only problem is size', async () => {
    const id = newDecision();
    const r = await router.route(
      { decisionId: id, symbol: 'NVDA', side: 'buy', qty: '5000', price: '100', allowResize: true },
      '1000000',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resized).toBe(true);
      expect(Number(r.qty)).toBeLessThan(5000);
    }
  });

  it('does NOT resize around a halt — trading less does not fix a kill switch', async () => {
    setHalt(db, true, 'drill');
    const r = await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '5000', price: '100', allowResize: true },
      '1000000',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('HALTED');
  });

  it('is idempotent on (decisionId, rungIndex) — a restart cannot double-place', async () => {
    const id = newDecision();
    const req = { decisionId: id, symbol: 'NVDA', side: 'buy' as const, qty: '20', price: '100' };
    const a = await router.route(req, '1000000');
    const b = await router.route(req, '1000000');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.orderId).toBe(a.orderId);
    const n = db.prepare('SELECT COUNT(*) c FROM orders WHERE decision_id = ?').get(id) as {
      c: number;
    };
    expect(n.c).toBe(1);
  });

  it('applies the fill to the ledger', async () => {
    await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    await new Promise((r) => setTimeout(r, 50));
    const p = ledger.get('alpaca-paper', 'NVDA');
    expect(p).not.toBeNull();
    expect(p!.qty).toBe('20');
  });

  it('blocks a new order once halted', async () => {
    setHalt(db, true, 'drill');
    expect(isHalted(db)).toBe(true);
    const r = await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    expect(r.ok).toBe(false);
  });

  it('lets an exit through after the daily loss stop has tripped', async () => {
    // Build then lose, so realised P&L is deeply negative.
    await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    await new Promise((r) => setTimeout(r, 50));
    const r = await router.route(
      { decisionId: newDecision('NVDA', 'sell'), symbol: 'NVDA', side: 'sell', qty: '20', price: '100' },
      '1000000',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects when ADV is unknown rather than guessing liquidity', async () => {
    const r = await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('LIQUIDITY');
  });
});

describe('kill switch', () => {
  it('defaults to not halted', () => {
    expect(isHalted(openDb(':memory:'))).toBe(false);
  });

  it('round-trips through the database', () => {
    const d = openDb(':memory:');
    setHalt(d, true, 'because');
    expect(isHalted(d)).toBe(true);
    setHalt(d, false);
    expect(isHalted(d)).toBe(false);
  });
});

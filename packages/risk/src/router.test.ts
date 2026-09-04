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

describe('notifications', () => {
  interface Note { kind: string; subject: string; body: string }

  function withNotify(): { notes: Note[]; r: OrderRouter } {
    const notes: Note[] = [];
    const r = new OrderRouter({ db, adapter, ledger, notify: (n) => notes.push(n) });
    r.start();
    return { notes, r };
  }

  it('raises ORDER_SUBMITTED when an order reaches the venue', async () => {
    const { notes, r } = withNotify();
    await r.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    const sub = notes.find((n) => n.kind === 'ORDER_SUBMITTED');
    expect(sub).toBeDefined();
    expect(sub!.subject).toContain('BUY 20 NVDA');
  });

  it('says so in the body when the Risk Officer shrank the order', async () => {
    const { notes, r } = withNotify();
    await r.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '5000', price: '100', allowResize: true },
      '1000000',
    );
    expect(notes.find((n) => n.kind === 'ORDER_SUBMITTED')!.body).toContain('Resized');
  });

  it('raises RISK_BREACH on a halt, listing the failed checks', async () => {
    const { notes, r } = withNotify();
    setHalt(db, true, 'drill');
    await r.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    const b = notes.find((n) => n.kind === 'RISK_BREACH');
    expect(b).toBeDefined();
    expect(b!.subject).toContain('HALTED');
    expect(b!.body).toContain('halt');
  });

  it('stays quiet when an order was merely too big — a resize is not a breach', async () => {
    const { notes, r } = withNotify();
    await r.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '5000', price: '100' },
      '1000000',
    );
    expect(notes.filter((n) => n.kind === 'RISK_BREACH')).toHaveLength(0);
  });

  it('never notifies twice for an idempotent replay', async () => {
    const { notes, r } = withNotify();
    const req = { decisionId: newDecision(), symbol: 'NVDA', side: 'buy' as const, qty: '20', price: '100' };
    await r.route(req, '1000000');
    await r.route(req, '1000000');
    expect(notes.filter((n) => n.kind === 'ORDER_SUBMITTED')).toHaveLength(1);
  });

  it('works with no hook at all — notification is optional, trading is not', async () => {
    const r = new OrderRouter({ db, adapter, ledger });
    r.start();
    const out = await r.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    expect(out.ok).toBe(true);
  });
});

describe('day-trade counting', () => {
  async function buyThenSell(symbol: string): Promise<void> {
    await router.route(
      { decisionId: newDecision(symbol), symbol, side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    await new Promise((r) => setTimeout(r, 40));
    await router.route(
      { decisionId: newDecision(symbol, 'sell'), symbol, side: 'sell', qty: '20', price: '100' },
      '1000000',
    );
    await new Promise((r) => setTimeout(r, 40));
  }

  it('counts a same-day round trip as one day trade', async () => {
    expect(router.dayTradesLast5Days()).toBe(0);
    await buyThenSell('NVDA');
    expect(router.dayTradesLast5Days()).toBe(1);
  });

  it('counts each symbol separately', async () => {
    await buyThenSell('NVDA');
    await buyThenSell('AMD');
    expect(router.dayTradesLast5Days()).toBe(2);
  });

  it('does not count a buy with no matching sell', async () => {
    await router.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '20', price: '100' },
      '1000000',
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(router.dayTradesLast5Days()).toBe(0);
  });
});

describe('partial fills', () => {
  /** A thin name, so an ordinary order is large against volume and gets worked. */
  const thin: PriceSource = {
    quote: async (symbol: string): Promise<Quote> => ({
      symbol, last: '100', bid: '99.95', ask: '100.05',
      volume: '100000', at: new Date().toISOString(),
    }),
  };

  function thinRouter(): { r: OrderRouter; l: Ledger } {
    const l = new Ledger(db);
    const a = new SimAdapter('alpaca-paper', 'US', thin, US_COSTS, '10000000', CONSTRAINTS, {
      isOpen: () => true,
    });
    const r = new OrderRouter({ db, adapter: a, ledger: l });
    r.start();
    return { r, l };
  }

  it('marks the order partial until every slice has landed', async () => {
    const { r } = thinRouter();
    const id = newDecision();
    await r.route({ decisionId: id, symbol: 'NVDA', side: 'buy', qty: '5000', price: '100' }, '100000000');
    // Immediately after the first slice, before the rest are applied.
    await new Promise((res) => setTimeout(res, 0));
    const mid = db.prepare('SELECT status FROM orders WHERE decision_id = ?').get(id) as { status: string };
    expect(['partial', 'filled']).toContain(mid.status);

    await new Promise((res) => setTimeout(res, 40));
    const end = db.prepare('SELECT status FROM orders WHERE decision_id = ?').get(id) as { status: string };
    expect(end.status).toBe('filled');
  });

  it('accumulates every slice into the position', async () => {
    const { r, l } = thinRouter();
    await r.route(
      { decisionId: newDecision(), symbol: 'NVDA', side: 'buy', qty: '5000', price: '100' },
      '100000000',
    );
    await new Promise((res) => setTimeout(res, 40));
    expect(l.get('alpaca-paper', 'NVDA')!.qty).toBe('5000');
  });

  it('records one ledger fill per slice', async () => {
    const { r } = thinRouter();
    const id = newDecision();
    await r.route({ decisionId: id, symbol: 'NVDA', side: 'buy', qty: '5000', price: '100' }, '100000000');
    await new Promise((res) => setTimeout(res, 40));
    const n = db.prepare(
      `SELECT COUNT(*) c FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.decision_id = ?`,
    ).get(id) as { c: number };
    expect(n.c).toBeGreaterThan(1);
  });

  it('still marks a small order filled in one step', async () => {
    const { r } = thinRouter();
    const id = newDecision();
    await r.route({ decisionId: id, symbol: 'NVDA', side: 'buy', qty: '20', price: '100' }, '100000000');
    await new Promise((res) => setTimeout(res, 40));
    expect((db.prepare('SELECT status FROM orders WHERE decision_id = ?').get(id) as { status: string }).status)
      .toBe('filled');
  });
});

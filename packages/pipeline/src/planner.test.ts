import { describe, it, expect, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import { SimAdapter, US_COSTS, type PriceSource, type Quote } from '@aegis/brokers';
import { Ledger } from '@aegis/ledger';
import { OrderRouter } from '@aegis/risk';
import type { YahooPriceSource } from '@aegis/marketdata';
import { EntryLadderAgent, planEntry, savePlan, activePlans, nextRung } from './planner.js';
import type { PipelineDeps } from './agents.js';

describe('planEntry', () => {
  const sum = (qtys: string[]): string =>
    qtys.reduce((a, q) => a.plus(q), new Decimal(0)).toString();

  it('never loses or invents size, whatever the rounding', () => {
    for (const total of ['100', '7', '333', '1', '9999']) {
      const p = planEntry(total, '100', 75);
      expect(sum(p.rungs.map((r) => r.qty))).toBe(total);
    }
  });

  it('leads with the largest rung — averaging up turns a small mistake into a large one', () => {
    for (const conviction of [95, 75, 55]) {
      const q = planEntry('1000', '100', conviction).rungs.map((r) => Number(r.qty));
      expect(q[0]).toBeGreaterThanOrEqual(Math.max(...q));
    }
  });

  it('takes most of the size at once on high conviction', () => {
    const p = planEntry('1000', '100', 90);
    expect(p.rungs).toHaveLength(2);
    expect(Number(p.rungs[0]!.qty)).toBe(700);
    expect(p.rationale).toContain('high conviction');
  });

  it('probes first on low conviction', () => {
    const p = planEntry('1000', '100', 50);
    expect(p.rungs).toHaveLength(3);
    expect(Number(p.rungs[0]!.qty)).toBe(400);
    expect(p.rationale).toContain('low conviction');
  });

  it('gives each later rung a higher ceiling, so a ladder is not a slow breakout chase', () => {
    const p = planEntry('1000', '100', 75);
    const ceilings = p.rungs.map((r) => Number(r.maxPrice));
    expect(ceilings[0]).toBe(100);
    expect(ceilings[1]).toBeGreaterThan(ceilings[0]!);
    expect(ceilings[2]).toBeGreaterThan(ceilings[1]!);
  });

  it('plans nothing for zero size or a zero price', () => {
    expect(planEntry('0', '100', 90).rungs).toEqual([]);
    expect(planEntry('100', '0', 90).rungs).toEqual([]);
  });

  it('collapses to a single rung when the size cannot be split', () => {
    const p = planEntry('1', '100', 50);
    expect(p.rungs).toHaveLength(1);
    expect(p.rungs[0]!.qty).toBe('1');
  });

  it('honours a maxRungs cap', () => {
    expect(planEntry('1000', '100', 50, { maxRungs: 2 }).rungs).toHaveLength(2);
  });
});

// ── The agent ───────────────────────────────────────────────────────────────

let db: Db;
let router: OrderRouter;
let ledger: Ledger;
let last = '100';
const lines: string[] = [];
const VENUE = 'sim-us';

const src: PriceSource = {
  quote: (symbol: string): Promise<Quote> =>
    Promise.resolve({
      symbol, last, bid: String(Number(last) - 0.01), ask: String(Number(last) + 0.01),
      volume: '50000000', at: new Date().toISOString(),
    }),
};

const prices = {
  quote: (s: string) => src.quote(s),
  bars: () => Promise.resolve(Array.from({ length: 30 }, () => ({ t: '', o: 1, h: 1, l: 1, c: 100, v: 5e7 }))),
} as unknown as YahooPriceSource;

function deps(): PipelineDeps & { prices: YahooPriceSource; router: OrderRouter } {
  return {
    db, bus: new SignalBus(db),
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    prices, router,
    edgar: {} as never, consensus: {} as never,
    universe: [], sueThreshold: 1.5, auditFloor: 70, autonomy: 'AUTO',
  };
}

function newPlan(totalQty: string, conviction: number): number {
  const d = db.prepare(
    `INSERT INTO decisions (symbol, market, venue, side, status) VALUES ('NVDA','US',?, 'buy','APPROVED')`,
  ).run(VENUE);
  const id = Number(d.lastInsertRowid);
  savePlan(db, id, VENUE, 'NVDA', 'buy', planEntry(totalQty, '100', conviction));
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  ledger = new Ledger(db);
  const adapter = new SimAdapter(VENUE, 'US', src, US_COSTS, '1000000', {
    tickSize: '0.01', lotSize: '1', minNotional: '1',
    supportsFractional: false, supportsShort: false,
  }, { isOpen: () => true });
  router = new OrderRouter({ db, adapter, ledger });
  router.start();
  last = '100';
  lines.length = 0;
});

const orders = (): number =>
  (db.prepare('SELECT COUNT(*) c FROM orders').get() as { c: number }).c;
const planStatus = (): string =>
  (db.prepare('SELECT status FROM execution_plans').get() as { status: string }).status;

describe('EntryLadderAgent', () => {
  it('does not run with no active plan', () => {
    expect(new EntryLadderAgent(deps()).shouldRun()).toBe(false);
  });

  it('places exactly one rung per tick — a ladder needs time to pass', async () => {
    newPlan('300', 75);
    const a = new EntryLadderAgent(deps());
    await a.execute();
    expect(orders()).toBe(1);
    await a.execute();
    expect(orders()).toBe(2);
  });

  it('marks the plan complete once every rung is placed', async () => {
    newPlan('300', 75);
    const a = new EntryLadderAgent(deps());
    for (let i = 0; i < 4; i += 1) await a.execute();
    expect(planStatus()).toBe('COMPLETE');
    expect(orders()).toBe(3);
  });

  it('abandons the remainder when price runs past the rung ceiling', async () => {
    newPlan('300', 75);
    const a = new EntryLadderAgent(deps());
    await a.execute();                 // rung 0 at 100
    last = '140';                      // way past rung 1's ceiling
    await a.execute();
    expect(planStatus()).toBe('ABANDONED');
    expect(orders()).toBe(1);
    expect(lines.join('\n')).toContain('above');
  });

  it('keeps laddering while price stays inside the band', async () => {
    newPlan('300', 75);
    const a = new EntryLadderAgent(deps());
    await a.execute();
    last = '101';                      // inside rung 1's 2% ceiling
    await a.execute();
    expect(orders()).toBe(2);
    expect(planStatus()).toBe('ACTIVE');
  });

  it('holds rather than guessing when the quote is missing', async () => {
    newPlan('300', 75);
    const d = deps();
    d.prices = { quote: () => Promise.resolve(null), bars: () => Promise.resolve([]) } as unknown as YahooPriceSource;
    await new EntryLadderAgent(d).execute();
    expect(orders()).toBe(0);
    expect(planStatus()).toBe('ACTIVE');
  });

  it('is idempotent: replaying a tick does not double-place a rung', async () => {
    newPlan('300', 75);
    const a = new EntryLadderAgent(deps());
    await a.execute();
    const first = db.prepare('SELECT id FROM orders').get() as { id: number };
    // The router is idempotent on (decision, rung); the plan records what it sent.
    await new EntryLadderAgent(deps()).execute();
    const all = db.prepare('SELECT id, rung_index FROM orders ORDER BY id').all() as
      { id: number; rung_index: number }[];
    expect(all[0]!.id).toBe(first.id);
    expect(new Set(all.map((o) => o.rung_index)).size).toBe(all.length);
  });

  it('abandons the plan when the Risk Officer refuses a rung', async () => {
    newPlan('300', 75);
    db.prepare(`UPDATE system_state SET halted = 1 WHERE id = 1`).run();
    await new EntryLadderAgent(deps()).execute();
    expect(planStatus()).toBe('ABANDONED');
    expect(orders()).toBe(0);
  });

  it('spends no model credit', async () => {
    newPlan('300', 75);
    const d = deps();
    await new EntryLadderAgent(d).execute();
    expect(d.budget.spent()).toBe('0');
  });
});

describe('nextRung', () => {
  it('returns the first unplaced rung', () => {
    newPlan('300', 75);
    const plan = activePlans(db, VENUE)[0]!;
    expect(nextRung(plan)!.index).toBe(0);
  });

  it('returns null once all rungs are recorded as placed', () => {
    newPlan('300', 75);
    db.prepare(`UPDATE execution_plans SET placed_rungs = '[0,1,2]'`).run();
    expect(nextRung(activePlans(db, VENUE)[0]!)).toBeNull();
  });
});

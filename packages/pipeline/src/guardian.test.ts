import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateExit, DRIFT_EXIT } from './guardian.js';

describe('evaluateExit', () => {
  it('holds a position sitting near entry', () => {
    const d = evaluateExit('100', '101', '101', 3);
    expect(d.exit).toBe(false);
  });

  it('stops out at the loss threshold', () => {
    const d = evaluateExit('100', '92', '100', 3);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('STOP_LOSS');
  });

  it('does not stop out just above the threshold', () => {
    expect(evaluateExit('100', '92.5', '100', 3).exit).toBe(false);
  });

  it('takes profit at the target', () => {
    const d = evaluateExit('100', '115', '115', 5);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TAKE_PROFIT');
  });

  it('does not arm the trailing stop before the position has run', () => {
    // Up only 2%, then back to entry. That is noise, not a give-back.
    expect(evaluateExit('100', '100', '102', 3).exit).toBe(false);
  });

  it('trails once the position has run and then gives back', () => {
    // Ran to +10%, now 5.5% off the high.
    const d = evaluateExit('100', '104', '110', 10);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TRAILING_STOP');
  });

  it('closes on the time stop once the drift window has passed', () => {
    const d = evaluateExit('100', '101', '101', 45);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TIME_STOP');
  });

  it('holds one day short of the time stop', () => {
    expect(evaluateExit('100', '101', '101', 44).exit).toBe(false);
  });

  it('prefers the stop-loss when a position is both old and losing', () => {
    // Protecting capital outranks the calendar.
    const d = evaluateExit('100', '85', '100', 60);
    expect(d.reason).toBe('STOP_LOSS');
  });

  it('treats the current price as the high when it exceeds the recorded mark', () => {
    const d = evaluateExit('100', '120', '105', 5);
    expect(d.exit).toBe(true);
    expect(d.reason).toBe('TAKE_PROFIT');
  });

  it('does not divide by zero on a missing entry price', () => {
    expect(evaluateExit('0', '100', '100', 5).exit).toBe(false);
  });

  it('respects a custom rule', () => {
    const tight = { ...DRIFT_EXIT, stopLossPct: 0.02 };
    expect(evaluateExit('100', '97', '100', 1, tight).reason).toBe('STOP_LOSS');
  });
});

// ── The agent, not just the rule ────────────────────────────────────────────

import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import { SimAdapter, US_COSTS, type PriceSource, type Quote } from '@aegis/brokers';
import { Ledger } from '@aegis/ledger';
import { OrderRouter, setHalt } from '@aegis/risk';
import { PositionGuardianAgent, pnlPct } from './guardian.js';
import type { PipelineDeps } from './agents.js';
import type { YahooPriceSource } from '@aegis/marketdata';

describe('pnlPct', () => {
  it('signs the move so a loss cannot read as a gain', () => {
    expect(pnlPct('100', '108')).toBe('+8.00%');
    expect(pnlPct('100', '91')).toBe('-9.00%');
  });
  it('refuses to divide by a zero entry', () => {
    expect(pnlPct('0', '100')).toBe('n/a');
  });
});

describe('PositionGuardianAgent', () => {
  const VENUE = 'sim-us';
  let db: Db;
  let ledger: Ledger;
  let router: OrderRouter;
  let mark = '100';
  const notes: { kind: string; subject: string; body: string }[] = [];
  const lines: string[] = [];

  const src: PriceSource = {
    quote: (symbol: string): Promise<Quote> =>
      Promise.resolve({
        symbol, last: mark,
        bid: String(Number(mark) - 0.01), ask: String(Number(mark) + 0.01),
        volume: '50000000', at: new Date().toISOString(),
      }),
  };

  function guardianDeps(): PipelineDeps & { ledger: Ledger; prices: YahooPriceSource; router: OrderRouter } {
    return {
      db,
      bus: new SignalBus(db),
      budget: new BudgetGovernor(db, 100, '2026-09-01'),
      log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
      ledger,
      prices: { quote: (s: string) => src.quote(s) } as unknown as YahooPriceSource,
      router,
      edgar: {} as never,
      consensus: {} as never,
      universe: [],
      sueThreshold: 1.5,
      auditFloor: 70,
      autonomy: 'AUTO',
      notify: (n) => notes.push(n),
    };
  }

  /** Buy 10 shares at 100 so there is something to guard. */
  function openPosition(): void {
    const d = db
      .prepare(`INSERT INTO decisions (symbol, market, venue, side, status) VALUES ('NVDA','US',?, 'buy','EXECUTED')`)
      .run(VENUE);
    const o = db
      .prepare(
        `INSERT INTO orders (decision_id, rung_index, venue, client_order_id, symbol, side, type, qty, status)
         VALUES (?,0,?, 'seed', 'NVDA', 'buy', 'market', '10', 'filled')`,
      )
      .run(d.lastInsertRowid, VENUE);
    ledger.applyFill(
      {
        clientOrderId: 'seed', venueOrderId: 'v', venueFillId: 'f',
        symbol: 'NVDA', side: 'buy', qty: '10', price: '100', fee: '0',
        filledAt: new Date().toISOString(),
      },
      Number(o.lastInsertRowid),
      VENUE,
    );
  }

  beforeEach(() => {
    db = openDb(':memory:');
    ledger = new Ledger(db);
    const adapter = new SimAdapter(VENUE, 'US', src, US_COSTS, '100000', {
      tickSize: '0.01', lotSize: '1', minNotional: '1',
      supportsFractional: false, supportsShort: false,
    }, { isOpen: () => true });
    router = new OrderRouter({ db, adapter, ledger });
    router.start();
    mark = '100';
    notes.length = 0;
    lines.length = 0;
  });

  it('does not run when nothing is open', () => {
    expect(new PositionGuardianAgent(guardianDeps()).shouldRun()).toBe(false);
  });

  it('holds a position that has not breached anything', async () => {
    openPosition();
    mark = '102';
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 0 });
    expect(notes).toHaveLength(0);
  });

  it('exits on a stop loss and says why, with the move in the subject', async () => {
    openPosition();
    mark = '89';                       // -11%, past the -8% stop
    await new PositionGuardianAgent(guardianDeps()).execute();
    const sells = db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get() as { c: number };
    expect(sells.c).toBe(1);
    const exited = notes.find((n) => n.kind === 'POSITION_EXITED');
    expect(exited).toBeDefined();
    expect(exited!.subject).toContain('STOP_LOSS');
    expect(exited!.subject).toContain('-11.00%');
    expect(exited!.body).toContain('Entry:     100.00');
  });

  it('exits on a take profit', async () => {
    openPosition();
    mark = '120';                      // +20%, past the +15% target
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(notes.find((n) => n.kind === 'POSITION_EXITED')!.subject).toContain('TAKE_PROFIT');
  });

  it('escalates loudly when an exit is refused — the position is still at risk', async () => {
    openPosition();
    mark = '85';
    setHalt(db, true, 'drill');        // a halt blocks even a sell
    await new PositionGuardianAgent(guardianDeps()).execute();
    const refused = notes.find((n) => n.kind === 'ORDER_REJECTED');
    expect(refused).toBeDefined();
    expect(refused!.subject).toContain('EXIT REFUSED');
    expect(refused!.body).toContain('still open and still at risk');
  });

  it('holds rather than guessing when the quote is missing', async () => {
    openPosition();
    const d = guardianDeps();
    d.prices = { quote: () => Promise.resolve(null) } as unknown as YahooPriceSource;
    await new PositionGuardianAgent(d).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 0 });
    expect(lines.join('\n')).toContain('no quote');
  });

  it('runs even at RULES_ONLY — the budget must never trap a position', async () => {
    openPosition();
    mark = '80';
    const d = guardianDeps();
    d.budget.record({
      agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1,
      costUsd: '99', latencyMs: 1, ok: true,
    });
    expect(d.budget.tier()).toBe('RULES_ONLY');
    await new PositionGuardianAgent(d).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 1 });
  });

  // ── Thesis-break exits ────────────────────────────────────────────────────

  /** Record the entry decision the guardian will look up, with its conditions. */
  function recordEntry(conditions: unknown): void {
    db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side, thesis_break, status)
       VALUES ('NVDA','US',?, 'buy', ?, 'EXECUTED')`,
    ).run(VENUE, JSON.stringify(conditions));
  }

  function newsSignal(direction: number, materiality: number): void {
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, data, created_at)
       VALUES ('news-scout','news_signal','NVDA',?, datetime('now','+1 second'))`,
    ).run(JSON.stringify({ direction, materiality }));
  }

  it('exits on a new filing before any price rule fires', async () => {
    openPosition();
    recordEntry([{ kind: 'NEW_FILING', why: 'the next report supersedes the surprise' }]);
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, data, created_at)
       VALUES ('edgar-poller','filing_8k','NVDA','{}', datetime('now','+1 second'))`,
    ).run();
    mark = '101';                       // nothing a price rule would act on
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 1 });
    expect(notes.find((n) => n.kind === 'POSITION_EXITED')!.subject).toContain('THESIS_BREAK');
  });

  it('exits on material opposing news while the position is still green', async () => {
    openPosition();
    recordEntry([{ kind: 'CONTRADICTING_NEWS', minMateriality: 70, why: 'the read is falsified' }]);
    newsSignal(-0.9, 85);
    mark = '104';                       // up 4% — no stop, no target
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 1 });
    expect(lines.join('\n')).toContain('THESIS_BREAK');
  });

  it('holds when the opposing news is below the materiality it was given', async () => {
    openPosition();
    recordEntry([{ kind: 'CONTRADICTING_NEWS', minMateriality: 70, why: 'x' }]);
    newsSignal(-0.9, 40);
    mark = '104';
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 0 });
  });

  it('holds when the news agrees with the position', async () => {
    openPosition();
    recordEntry([{ kind: 'CONTRADICTING_NEWS', minMateriality: 70, why: 'x' }]);
    newsSignal(0.95, 99);
    mark = '104';
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 0 });
  });

  it('says so, and holds, when the recorded thesis is prose it cannot evaluate', async () => {
    openPosition();
    recordEntry(['guidance is lowered or withdrawn at the next report']);
    mark = '101';
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(lines.join('\n')).toContain('cannot be evaluated');
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 0 });
  });

  it('still applies the price stop when no thesis was recorded at all', async () => {
    openPosition();
    mark = '89';
    await new PositionGuardianAgent(guardianDeps()).execute();
    expect(notes.find((n) => n.kind === 'POSITION_EXITED')!.subject).toContain('STOP_LOSS');
  });

  it('checks the thesis with no model call, so it works at RULES_ONLY', async () => {
    openPosition();
    recordEntry([{ kind: 'PRICE_BELOW', value: '95', why: 'the drift did not materialise' }]);
    mark = '94';
    const d = guardianDeps();
    d.budget.record({ agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1, costUsd: '99', latencyMs: 1, ok: true });
    expect(d.budget.tier()).toBe('RULES_ONLY');
    await new PositionGuardianAgent(d).execute();
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='sell'`).get()).toEqual({ c: 1 });
    expect(d.budget.spent()).toBe('99.000000');
  });
});

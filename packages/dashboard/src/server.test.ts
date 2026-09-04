import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { isHalted } from '@aegis/risk';
import { Dashboard } from './server.js';

let db: Db;
let dash: Dashboard;
const PORT = 38771;

beforeEach(() => {
  db = openDb(':memory:');
  dash = new Dashboard({ db, port: PORT, monthlyBudgetUsd: 100, autonomy: 'SHADOW', venue: 'sim' });
});
afterEach(() => { dash.stop(); });

describe('Dashboard.snapshot', () => {
  it('reports a safe default state on an empty database', () => {
    const s = dash.snapshot();
    expect(s.halted).toBe(false);
    expect(s.autonomy).toBe('SHADOW');
    expect(s.positions).toEqual([]);
    expect(s.decisions).toEqual([]);
  });

  it('surfaces budget spend and tier', () => {
    db.prepare(
      `INSERT INTO budget_cycles (cycle_start, budget_usd, spent_usd, tier) VALUES (?,?,?,?)`,
    ).run(`${new Date().toISOString().slice(0, 7)}-01`, '100', '42.5', 'CONSERVE');
    const b = dash.snapshot().budget as { spent: string; tier: string };
    expect(Number(b.spent)).toBeCloseTo(42.5, 2);
    expect(b.tier).toBe('CONSERVE');
  });

  it('shows a decision with its reasoning chain', () => {
    db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side, sue_score, audit_score, audit_tier, rationale, status)
       VALUES ('NVDA','US','sim','buy','2.10',78,'HIGH','strong beat','APPROVED')`,
    ).run();
    const d = dash.snapshot().decisions as { symbol: string; audit_score: number }[];
    expect(d).toHaveLength(1);
    expect(d[0]!.symbol).toBe('NVDA');
    expect(d[0]!.audit_score).toBe(78);
  });

  it('aggregates model cost per agent', () => {
    for (const [agent, c] of [['earnings-reader', '0.02'], ['earnings-reader', '0.03'], ['thesis-auditor', '0.01']]) {
      db.prepare(
        `INSERT INTO llm_calls (agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok)
         VALUES (?,?,?,?,?,?,1)`,
      ).run(agent, 'sonnet', 1000, 100, c, 5000);
    }
    const rows = dash.snapshot().costByAgent as { agent: string; calls: number; cost: number }[];
    const reader = rows.find((r) => r.agent === 'earnings-reader')!;
    expect(reader.calls).toBe(2);
    expect(reader.cost).toBeCloseTo(0.05, 4);
  });

  it('distinguishes pending from consumed signals', () => {
    db.prepare(`INSERT INTO agent_signals (agent, signal_type, symbol) VALUES ('a','filing_8k','X')`).run();
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, consumed, consumed_by) VALUES ('a','filing_8k','Y',1,'reader')`,
    ).run();
    const sig = dash.snapshot().signals as { consumed: number }[];
    expect(sig.filter((s) => s.consumed === 0)).toHaveLength(1);
  });
});

describe('Dashboard HTTP', () => {
  it('serves the UI, the snapshot API, and toggles the kill switch', async () => {
    dash.start();
    await new Promise((r) => setTimeout(r, 120));

    const page = await fetch(`http://127.0.0.1:${String(PORT)}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Aegis');
    expect(html).toContain('Paper money only');

    const snap = await (await fetch(`http://127.0.0.1:${String(PORT)}/api/snapshot`)).json();
    expect(snap).toHaveProperty('budget');

    expect(isHalted(db)).toBe(false);
    const r = await (await fetch(`http://127.0.0.1:${String(PORT)}/api/halt`, { method: 'POST' })).json();
    expect(r).toEqual({ halted: true });
    expect(isHalted(db)).toBe(true);
  }, 15_000);
});

describe('panels that were collecting data but showing none', () => {
  it('lists every venue, not just the first', () => {
    const multi = new Dashboard({
      db, port: PORT + 1, monthlyBudgetUsd: 100, autonomy: 'SHADOW',
      venue: 'sim-us', venues: ['sim-us', 'sim-crypto', 'sim-india'],
    });
    expect(multi.snapshot()['venues']).toEqual(['sim-us', 'sim-crypto', 'sim-india']);
    multi.stop();
  });

  it('falls back to the single venue when none are listed', () => {
    expect(dash.snapshot()['venues']).toEqual(['sim']);
  });

  it('surfaces the Reflector’s lessons', () => {
    db.prepare(
      `INSERT INTO lessons (symbol, venue, source, raw_return, benchmark_return,
                            alpha_return, verdict, category, lesson)
       VALUES ('NVDA','sim-us','earnings', 0.08, 0.12, -0.04, 'MARKET_CARRIED',
               'entered-after-the-move', 'The story was already priced.')`,
    ).run();
    const rows = dash.snapshot()['lessons'] as { verdict: string; alpha_pct: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('MARKET_CARRIED');
    expect(rows[0]!.alpha_pct).toBe(-4);
  });

  it('shows a staged entry as rungs placed out of rungs planned', () => {
    const dec = db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side) VALUES ('NVDA','US','sim-us','buy')`,
    ).run();
    db.prepare(
      `INSERT INTO execution_plans (decision_id, venue, symbol, side, rungs, placed_rungs, status)
       VALUES (?, 'sim-us','NVDA','buy', ?, '[0]', 'ACTIVE')`,
    ).run(dec.lastInsertRowid, JSON.stringify([{ index: 0 }, { index: 1 }, { index: 2 }]));
    const rows = dash.snapshot()['plans'] as { total: number; placed: number }[];
    expect(rows[0]).toMatchObject({ total: 3, placed: 1 });
  });

  it('does not blank the ladder panel on a malformed plan', () => {
    const dec2 = db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side) VALUES ('X','US','sim-us','buy')`,
    ).run();
    db.prepare(
      `INSERT INTO execution_plans (decision_id, venue, symbol, side, rungs) VALUES (?, 'sim-us','X','buy','{bad')`,
    ).run(dec2.lastInsertRowid);
    const rows = dash.snapshot()['plans'] as { total: number }[];
    expect(rows[0]!.total).toBe(0);
  });

  it('reads a clean reconciliation as agreed and a broken one as not', () => {
    db.prepare(`INSERT INTO reconciliations (venue, matched, breaks) VALUES ('sim-us', 3, '[]')`).run();
    db.prepare(
      `INSERT INTO reconciliations (venue, matched, breaks) VALUES ('sim-us', 2, '[{"symbol":"NVDA"}]')`,
    ).run();
    const rows = dash.snapshot()['reconciliations'] as { ok: number }[];
    expect(rows[0]!.ok).toBe(0);   // newest first: the break
    expect(rows[1]!.ok).toBe(1);
  });

  it('shows the notification outbox including what has not sent', () => {
    db.prepare(
      `INSERT INTO notifications (kind, subject, body, status, attempts)
       VALUES ('ORDER_FILLED','BUY 10 NVDA','body','pending', 2)`,
    ).run();
    const rows = dash.snapshot()['notifications'] as { kind: string; status: string }[];
    expect(rows[0]).toMatchObject({ kind: 'ORDER_FILLED', status: 'pending' });
  });
});

describe('balances', () => {
  function withAccount(equity: string, cash: string): Dashboard {
    const d = new Dashboard({
      db, port: PORT + 2, monthlyBudgetUsd: 100, autonomy: 'AUTO', venue: 'sim-us',
      account: () => ({ equity, cash }),
    });
    return d;
  }

  function position(symbol: string, qty: string, avgCost: string, realised = '0'): void {
    db.prepare(
      `INSERT INTO positions (venue, symbol, qty, avg_cost, realised_pnl, opened_at)
       VALUES ('sim-us', ?, ?, ?, ?, datetime('now'))`,
    ).run(symbol, qty, avgCost, realised);
  }

  it('reports nothing rather than zero when the venue has not answered', () => {
    // "Unknown" and "nothing" are different. Showing 0% deployed on a full book
    // is worse than showing nothing at all.
    const b = dash.snapshot()['balances'] as Record<string, unknown>;
    expect(b['equity']).toBeNull();
    expect(b['deployedPct']).toBeNull();
  });

  it('separates long and short exposure', () => {
    position('NVDA', '100', '150');
    position('META', '-20', '500');
    const d = withAccount('100000', '80000');
    const b = d.snapshot()['balances'] as Record<string, unknown>;
    expect(b['longNotional']).toBe('15000.00');
    expect(b['shortNotional']).toBe('10000.00');
    expect(b['openPositions']).toBe(2);
    d.stop();
  });

  it('counts a short as invested, not as negative investment', () => {
    // A short ties up margin and carries risk; netting it against longs would
    // report a hedged book as flat.
    position('META', '-20', '500');
    const d = withAccount('100000', '110000');
    expect((d.snapshot()['balances'] as Record<string, unknown>)['invested']).toBe('10000.00');
    d.stop();
  });

  it('reports how much of the account is deployed', () => {
    position('NVDA', '100', '250');
    const d = withAccount('100000', '75000');
    const b = d.snapshot()['balances'] as Record<string, number>;
    expect(b['deployedPct']).toBeCloseTo(25, 1);
    d.stop();
  });

  it('sums realised P&L across closed and open positions', () => {
    position('NVDA', '0', '100', '250.50');
    position('AMD', '10', '50', '-40');
    const d = withAccount('100000', '99000');
    expect((d.snapshot()['balances'] as Record<string, unknown>)['realised']).toBe('210.50');
    d.stop();
  });

  it('does not divide by a zero equity', () => {
    position('NVDA', '10', '100');
    const d = withAccount('0', '0');
    expect((d.snapshot()['balances'] as Record<string, unknown>)['deployedPct']).toBeNull();
    d.stop();
  });
});

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

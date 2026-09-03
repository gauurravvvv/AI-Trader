import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from './db.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('openDb', () => {
  it('creates all core tables', () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ['agent_signals', 'agent_logs', 'llm_calls', 'budget_cycles', '_migrations']) {
      expect(names).toContain(t);
    }
  });

  it('enables foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('records the migration exactly once even if applied twice', () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c;
    db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run('001_initial');
    const after = (db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('agent_signals defaults to unconsumed', () => {
    db.prepare(
      `INSERT INTO agent_signals (agent, signal_type, symbol, confidence, data)
       VALUES (?,?,?,?,?)`,
    ).run('news-triage', 'bullish_news', 'NVDA', 70, '{}');
    const row = db.prepare('SELECT * FROM agent_signals').get() as {
      consumed: number;
      consumed_by: string | null;
    };
    expect(row.consumed).toBe(0);
    expect(row.consumed_by).toBeNull();
  });

  it('llm_calls stores cost with enough precision for sub-cent calls', () => {
    db.prepare(
      `INSERT INTO llm_calls (agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('news-triage', 'haiku', 2000, 200, '0.003000', 6200, 1);
    const row = db.prepare('SELECT cost_usd FROM llm_calls').get() as { cost_usd: string };
    expect(Number(row.cost_usd)).toBeCloseTo(0.003, 6);
  });
});

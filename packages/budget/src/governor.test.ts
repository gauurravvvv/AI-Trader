import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { BudgetGovernor } from './governor.js';

let g: BudgetGovernor;
let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
  g = new BudgetGovernor(db, 100, '2026-09-01');
});

function burn(usd: number): void {
  g.record({
    agent: 't', model: 'sonnet', tokensIn: 1, tokensOut: 1,
    costUsd: usd.toFixed(6), latencyMs: 1, ok: true,
  });
}

describe('BudgetGovernor', () => {
  it('starts NORMAL with nothing spent', () => {
    expect(g.tier()).toBe('NORMAL');
    expect(Number(g.spent())).toBe(0);
    expect(Number(g.remaining())).toBe(100);
  });

  it('accumulates spend across calls', () => {
    burn(1.5); burn(2.25);
    expect(Number(g.spent())).toBeCloseTo(3.75, 6);
  });

  it('crosses into CONSERVE at 70%', () => {
    burn(69.9); expect(g.tier()).toBe('NORMAL');
    burn(0.2); expect(g.tier()).toBe('CONSERVE');
  });

  it('crosses into ESSENTIAL at 85% and RULES_ONLY at 95%', () => {
    burn(86); expect(g.tier()).toBe('ESSENTIAL');
    burn(10); expect(g.tier()).toBe('RULES_ONLY');
  });

  it('reports CONSERVE as restricting discretionary work, without enforcing it', () => {
    burn(75);
    expect(g.wouldRestrict('discretionary')).toBe(true);
    expect(g.wouldRestrict('entry')).toBe(false);
    expect(g.wouldRestrict('position_protecting')).toBe(false);
  });

  it('reports ESSENTIAL as restricting entries, without enforcing it', () => {
    burn(90);
    expect(g.wouldRestrict('entry')).toBe(true);
    expect(g.wouldRestrict('position_protecting')).toBe(false);
  });

  it('reports RULES_ONLY as restricting everything, without enforcing it', () => {
    burn(99);
    for (const k of ['discretionary', 'entry', 'position_protecting'] as const) {
      expect(g.wouldRestrict(k)).toBe(true);
      // Reported, not enforced: spend is a yardstick, not a wallet.
      expect(g.allows(k)).toBe(true);
    }
  });

  it('only blocks while a plan usage limit is in force', () => {
    expect(g.allows('entry')).toBe(true);
    g.pause(Date.now() + 600_000, 'usage limit reached');
    expect(g.paused()).toBe(true);
    expect(g.allows('entry')).toBe(false);
    g.resume();
    expect(g.allows('entry')).toBe(true);
  });

  it('treats an elapsed backoff as over', () => {
    g.pause(Date.now() - 1000, 'expired');
    expect(g.paused()).toBe(false);
    expect(g.allows('entry')).toBe(true);
  });

  it('remembers a backoff across a restart, so it does not resume hammering', () => {
    g.pause(Date.now() + 600_000, 'usage limit');
    const fresh = new BudgetGovernor(db, 100, '2026-09-01');
    expect(fresh.paused()).toBe(true);
  });

  it('records failed calls too — a timeout still consumed budget', () => {
    g.record({
      agent: 't', model: 'sonnet', tokensIn: 5000, tokensOut: 0,
      costUsd: '0.015000', latencyMs: 180000, ok: false, error: 'TIMEOUT',
    });
    expect(Number(g.spent())).toBeCloseTo(0.015, 6);
  });

  it('survives a restart by reloading the cycle row', () => {
    const db = openDb(':memory:');
    const a = new BudgetGovernor(db, 100, '2026-09-01');
    a.record({
      agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1,
      costUsd: '5.000000', latencyMs: 1, ok: true,
    });
    const b = new BudgetGovernor(db, 100, '2026-09-01');
    expect(Number(b.spent())).toBeCloseTo(5, 6);
  });
});

describe('tier notifications', () => {
  interface Note { kind: string; subject: string; body: string }

  function spend(g: BudgetGovernor, usd: string): void {
    g.record({
      agent: 'test', model: 'haiku', tokensIn: 1, tokensOut: 1,
      costUsd: usd, latencyMs: 1, ok: true,
    });
  }

  it('announces a tier change once, not on every call after it', () => {
    const db = openDb(':memory:');
    const notes: Note[] = [];
    const g = new BudgetGovernor(db, 100, '2026-09-01', (n) => notes.push(n));

    spend(g, '50');            // 50% — still NORMAL
    expect(notes).toHaveLength(0);
    spend(g, '25');            // 75% — CONSERVE
    expect(notes).toHaveLength(1);
    expect(notes[0]!.subject).toContain('NORMAL → CONSERVE');
    spend(g, '1');             // 76% — still CONSERVE
    expect(notes).toHaveLength(1);
    spend(g, '10');            // 86% — ESSENTIAL
    expect(notes).toHaveLength(2);
    expect(notes[1]!.subject).toContain('CONSERVE → ESSENTIAL');
  });

  it('explains that exits still work at RULES_ONLY', () => {
    const db = openDb(':memory:');
    const notes: Note[] = [];
    const g = new BudgetGovernor(db, 100, '2026-09-01', (n) => notes.push(n));
    spend(g, '96');
    expect(g.tier()).toBe('RULES_ONLY');
    expect(notes.at(-1)!.body).toContain('Exits, stops and the kill switch still work');
  });

  it('does not re-announce a tier the operator was already told about', () => {
    const db = openDb(':memory:');
    const first: Note[] = [];
    const g = new BudgetGovernor(db, 100, '2026-09-01', (n) => first.push(n));
    spend(g, '75');
    expect(first).toHaveLength(1);

    // A restart against the same database reads the persisted spend.
    const second: Note[] = [];
    const g2 = new BudgetGovernor(db, 100, '2026-09-01', (n) => second.push(n));
    spend(g2, '0.01');
    expect(second).toHaveLength(0);
    expect(g2.tier()).toBe('CONSERVE');
  });
});

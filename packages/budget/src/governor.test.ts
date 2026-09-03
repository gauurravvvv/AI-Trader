import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { BudgetGovernor } from './governor.js';

let g: BudgetGovernor;
beforeEach(() => {
  g = new BudgetGovernor(openDb(':memory:'), 100, '2026-09-01');
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

  it('blocks discretionary calls in CONSERVE but still allows entries', () => {
    burn(75);
    expect(g.allows('discretionary')).toBe(false);
    expect(g.allows('entry')).toBe(true);
    expect(g.allows('position_protecting')).toBe(true);
  });

  it('blocks new entries in ESSENTIAL but still protects open positions', () => {
    burn(90);
    expect(g.allows('entry')).toBe(false);
    expect(g.allows('position_protecting')).toBe(true);
  });

  it('blocks every LLM call in RULES_ONLY — deterministic exits must still work', () => {
    burn(99);
    for (const k of ['discretionary', 'entry', 'position_protecting'] as const) {
      expect(g.allows(k)).toBe(false);
    }
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

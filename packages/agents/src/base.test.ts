import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus } from './bus.js';
import { BaseAgent, type AgentDeps } from './base.js';

function deps(now?: () => number): AgentDeps {
  const db = openDb(':memory:');
  return {
    db,
    bus: new SignalBus(db),
    log: createLogger({ colour: false, sink: () => {} }),
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    ...(now ? { now } : {}),
  };
}

class Spy extends BaseAgent {
  runs = 0;
  throwNext = false;
  gate = true;
  constructor(d: AgentDeps) {
    super('spy', { intervalMs: 1000 }, d);
  }
  override shouldRun(): boolean {
    return this.gate;
  }
  async execute(): Promise<void> {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('boom');
    }
    this.runs++;
  }
}

describe('BaseAgent', () => {
  let a: Spy;
  beforeEach(() => {
    a = new Spy(deps());
  });

  it('runs execute on tick when the gate is open', async () => {
    await a.tick();
    expect(a.runs).toBe(1);
  });

  it('skips when shouldRun is false and counts the skip', async () => {
    a.gate = false;
    await a.tick();
    expect(a.runs).toBe(0);
    expect(a.stats().skipped).toBe(1);
  });

  it('never lets an execute() throw escape the tick', async () => {
    a.throwNext = true;
    await expect(a.tick()).resolves.toBeUndefined();
    expect(a.stats().errors).toBe(1);
  });

  it('does not run concurrently with itself', async () => {
    let inside = 0;
    let maxInside = 0;
    class Slow extends BaseAgent {
      constructor(d: AgentDeps) {
        super('slow', { intervalMs: 10 }, d);
      }
      async execute(): Promise<void> {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside--;
      }
    }
    const s = new Slow(deps());
    await Promise.all([s.tick(), s.tick(), s.tick()]);
    expect(maxInside).toBe(1);
  });

  it('detects a sleep gap and logs a wake recovery', async () => {
    let t = 1_000_000;
    const d = deps(() => t);
    const s = new Spy(d);
    await s.tick();
    t += 60 * 60 * 1000; // laptop lid closed for an hour
    await s.tick();
    const rows = d.db.prepare("SELECT * FROM agent_logs WHERE action = 'wake_recovery'").all();
    expect(rows).toHaveLength(1);
  });

  it('does not report a wake gap when execute() simply ran long', async () => {
    // An 85s model call on a 60s ticker is slow work, not a suspended laptop.
    // Measuring start-to-start would flag it every time.
    let t = 1_000_000;
    const d = deps(() => t);
    class Slow extends BaseAgent {
      constructor(x: AgentDeps) { super('slow', { intervalMs: 60_000 }, x); }
      async execute(): Promise<void> { t += 85_000; }
    }
    const s = new Slow(d);
    await s.tick();
    await s.tick();
    const rows = d.db.prepare("SELECT * FROM agent_logs WHERE action = 'wake_recovery'").all();
    expect(rows).toHaveLength(0);
  });

  it('does not log a wake recovery for a normal interval', async () => {
    let t = 1_000_000;
    const d = deps(() => t);
    const s = new Spy(d);
    await s.tick();
    t += 1100;
    await s.tick();
    const rows = d.db.prepare("SELECT * FROM agent_logs WHERE action = 'wake_recovery'").all();
    expect(rows).toHaveLength(0);
  });

  it('respects disable()', async () => {
    a.disable();
    await a.tick();
    expect(a.runs).toBe(0);
  });
});

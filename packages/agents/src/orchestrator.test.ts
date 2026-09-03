import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { BudgetGovernor } from '@aegis/budget';
import { SignalBus } from './bus.js';
import { BaseAgent, type AgentDeps } from './base.js';
import { Orchestrator } from './orchestrator.js';

function deps(): AgentDeps {
  const db = openDb(':memory:');
  return {
    db,
    bus: new SignalBus(db),
    log: createLogger({ colour: false, sink: () => {} }),
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
  };
}

class Noop extends BaseAgent {
  constructor(n: string, d: AgentDeps) {
    super(n, { intervalMs: 60_000 }, d);
  }
  async execute(): Promise<void> {
    /* nothing */
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Orchestrator', () => {
  it('staggers starts so agents do not all fire at once', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const a = new Noop('a', d);
    const b = new Noop('b', d);
    const sa = vi.spyOn(a, 'start');
    const sb = vi.spyOn(b, 'start');
    o.register(a, 0);
    o.register(b, 5000);
    o.start();
    expect(sa).toHaveBeenCalled();
    expect(sb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(sb).toHaveBeenCalled();
    o.stop();
  });

  it('stops every registered agent', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const a = new Noop('a', d);
    const stop = vi.spyOn(a, 'stop');
    o.register(a, 0);
    o.start();
    o.stop();
    expect(stop).toHaveBeenCalled();
  });

  it('cancels pending staggered starts on stop', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const b = new Noop('b', d);
    const sb = vi.spyOn(b, 'start');
    o.register(b, 5000);
    o.start();
    o.stop();
    vi.advanceTimersByTime(10_000);
    expect(sb).not.toHaveBeenCalled();
  });

  it('reports status for all agents', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    o.register(new Noop('a', d), 0);
    o.register(new Noop('b', d), 0);
    expect(o.status().map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('is idempotent — a second start does not double-register', () => {
    const d = deps();
    const o = new Orchestrator(d.log);
    const a = new Noop('a', d);
    const s = vi.spyOn(a, 'start');
    o.register(a, 0);
    o.start();
    o.start();
    expect(s).toHaveBeenCalledTimes(1);
    o.stop();
  });
});

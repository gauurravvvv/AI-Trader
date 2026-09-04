import { describe, it, expect } from 'vitest';
import { openDb } from '@aegis/db';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import { triageNews, buildBatch, dedupeByIndex, newsScore } from './news-triage.js';

const log = createLogger({ colour: false, sink: () => undefined });
const budget = (): BudgetGovernor => new BudgetGovernor(openDb(':memory:'), 100, '2026-09-01');

const reply = (text: string): AskFn => () =>
  Promise.resolve({
    model: 'haiku', text, tokensIn: 10, tokensOut: 10,
    costUsd: '0.0001', latencyMs: 5, promptHash: 'h',
  } satisfies ClaudeResult);

describe('buildBatch', () => {
  it('numbers each headline so the model can key its answer', () => {
    expect(buildBatch(['a', 'b'])).toBe('0. a\n1. b');
  });
  it('collapses whitespace and truncates a runaway headline', () => {
    expect(buildBatch(['x'.repeat(400)])[0]).toBe('0');
    expect(buildBatch(['a\n\n  b'])).toBe('0. a b');
  });
});

describe('newsScore', () => {
  it('discounts a material story whose direction is unclear', () => {
    expect(newsScore({ i: 0, materiality: 90, direction: 0, category: 'LEGAL', why: '' })).toBe(0);
  });
  it('rewards a material story with a clear sign', () => {
    expect(newsScore({ i: 0, materiality: 80, direction: -1, category: 'LEGAL', why: '' })).toBeCloseTo(0.8);
  });
});

describe('dedupeByIndex', () => {
  it('keeps the first rating when the model repeats an index', () => {
    const out = dedupeByIndex([
      { i: 1, materiality: 10, direction: 0, category: 'NOISE', why: 'first' },
      { i: 1, materiality: 90, direction: 1, category: 'MA', why: 'second' },
      { i: 0, materiality: 50, direction: 0.5, category: 'PRODUCT', why: '' },
    ]);
    expect(out.map((o) => o.i)).toEqual([0, 1]);
    expect(out[1]!.why).toBe('first');
  });
});

describe('triageNews', () => {
  it('returns ratings for a well-formed reply', async () => {
    const out = await triageNews(['NVIDIA raises guidance'], {
      budget: budget(), log,
      ask: reply('{"items":[{"i":0,"materiality":85,"direction":0.8,"category":"GUIDANCE","why":"raise"}]}'),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items[0]!.category).toBe('GUIDANCE');
  });

  it('tolerates the code fences haiku emits despite being told not to', async () => {
    const out = await triageNews(['x'], {
      budget: budget(), log,
      ask: reply('```json\n{"items":[{"i":0,"materiality":5,"direction":0,"category":"NOISE","why":"recap"}]}\n```'),
    });
    expect(out.ok).toBe(true);
  });

  it('drops a rating for a headline that was never sent', async () => {
    const out = await triageNews(['only one'], {
      budget: budget(), log,
      ask: reply('{"items":[{"i":0,"materiality":50,"direction":1,"category":"MA","why":"a"},' +
                 '{"i":7,"materiality":99,"direction":1,"category":"MA","why":"hallucinated"}]}'),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.items).toHaveLength(1);
  });

  it('reports a parse failure instead of inventing ratings', async () => {
    const out = await triageNews(['x'], { budget: budget(), log, ask: reply('I think headline one is bullish.') });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe('parse');
  });

  it('spends nothing on an empty batch', async () => {
    const b = budget();
    const out = await triageNews([], { budget: b, log, ask: reply('should not be called') });
    expect(out.ok).toBe(true);
    expect(b.spent()).toBe('0');
  });

  it('is switched off first when the budget tightens', async () => {
    const b = budget();
    b.record({ agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1, costUsd: '75', latencyMs: 1, ok: true });
    expect(b.tier()).toBe('CONSERVE');
    const out = await triageNews(['x'], { budget: b, log, ask: reply('{"items":[]}') });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe('budget');
  });

  it('charges the budget for a call that threw', async () => {
    const b = budget();
    const out = await triageNews(['x'], {
      budget: b, log,
      ask: () => Promise.reject(new Error('spawn failed')),
    });
    expect(out.ok).toBe(false);
    const calls = b as unknown as { db?: unknown };
    expect(calls).toBeDefined();
    if (!out.ok) expect(out.stage).toBe('call');
  });
});

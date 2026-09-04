import { describe, it, expect } from 'vitest';
import { openDb } from '@aegis/db';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import { triageNews, buildBatch, dedupeByIndex, newsScore, normaliseCategory, parseItems, salvageObjects } from './news-triage.js';

const log = createLogger({ colour: false, sink: () => undefined });
const budget = (): BudgetGovernor => new BudgetGovernor(openDb(':memory:'), 100, '2026-09-01');

const reply = (text: string): AskFn => () =>
  Promise.resolve({
    model: 'haiku', text, tokensIn: 10, tokensOut: 10,
    costUsd: '0.0001', latencyMs: 5, promptHash: 'h',
    cacheReadTokens: 27414, cacheCreateTokens: 0, costMeasured: true,
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

describe('normaliseCategory', () => {
  it('accepts a category the enum already has', () => {
    expect(normaliseCategory('GUIDANCE')).toEqual({ category: 'GUIDANCE', unknown: null });
  });

  it('maps the labels the model actually invented in the first live run', () => {
    // Observed live: BUSINESS, COMPETITIVE and TRANSITION, which under a strict
    // enum discarded all twelve ratings in the batch.
    expect(normaliseCategory('BUSINESS').category).toBe('PRODUCT');
    expect(normaliseCategory('COMPETITIVE').category).toBe('PRODUCT');
    expect(normaliseCategory('TRANSITION').category).toBe('LEADERSHIP');
  });

  it('normalises case, spaces and hyphens', () => {
    expect(normaliseCategory('price target').category).toBe('ANALYST');
    expect(normaliseCategory('  Regulatory ').category).toBe('REGULATORY');
  });

  it('files anything else under OTHER and reports the label', () => {
    expect(normaliseCategory('VIBES')).toEqual({ category: 'OTHER', unknown: 'VIBES' });
  });

  it('does not throw on a non-string', () => {
    expect(normaliseCategory(42).category).toBe('OTHER');
    expect(normaliseCategory(undefined).category).toBe('OTHER');
  });
});

describe('parseItems', () => {
  const good = { i: 0, materiality: 80, direction: 0.9, category: 'GUIDANCE', why: 'raise' };

  it('keeps the good rows when one row is malformed', () => {
    const out = parseItems([good, { i: 1, materiality: 'lots', direction: 0, category: 'NOISE' }]);
    expect(out.items).toHaveLength(1);
    expect(out.dropped).toBe(1);
  });

  it('rescues a row whose only fault was an invented category', () => {
    const out = parseItems([{ ...good, category: 'BUSINESS' }]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.category).toBe('PRODUCT');
    expect(out.dropped).toBe(0);
  });

  it('collects the unknown labels so the enum can be tuned from evidence', () => {
    const out = parseItems([{ ...good, category: 'VIBES' }, { ...good, i: 1, category: 'MOMENTUM' }]);
    expect(out.unknownCategories.sort()).toEqual(['MOMENTUM', 'VIBES']);
  });

  it('drops a row that is not an object at all', () => {
    expect(parseItems(['nonsense', null, good]).items).toHaveLength(1);
  });

  it('defaults a missing why rather than failing the row', () => {
    const out = parseItems([{ i: 0, materiality: 50, direction: 1, category: 'MA' }]);
    expect(out.items[0]!.why).toBe('');
  });

  it('rejects an out-of-range score — that is a real error, not a label', () => {
    expect(parseItems([{ ...good, materiality: 500 }]).items).toHaveLength(0);
  });
});

describe('triageNews resilience', () => {
  it('survives the reply shape that broke the first live run', async () => {
    const out = await triageNews(['a', 'b', 'c'], {
      budget: budget(), log,
      ask: reply(JSON.stringify({
        items: [
          { i: 0, materiality: 70, direction: 0.6, category: 'GUIDANCE', why: 'raise' },
          { i: 1, materiality: 40, direction: 0.2, category: 'BUSINESS', why: 'deal' },
          { i: 2, materiality: 55, direction: -0.4, category: 'COMPETITIVE', why: 'share loss' },
        ],
      })),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.items).toHaveLength(3);
      expect(out.items.map((i) => i.category)).toEqual(['GUIDANCE', 'PRODUCT', 'PRODUCT']);
    }
  });
});

describe('salvageObjects', () => {
  it('recovers every complete object from a truncated array', () => {
    const text = '```json\n{"items":[{"i":0,"materiality":80,"direction":1,"category":"MA","why":"a"},' +
                 '{"i":1,"materiality":20,"direction":0,"category":"NOISE","why":"b"},' +
                 '{"i":2,"materiality":45,"direction":';
    const out = salvageObjects(text);
    // The envelope object never closes, so only the two complete ratings survive.
    expect(out).toHaveLength(2);
    expect((out[0] as { i: number }).i).toBe(0);
  });

  it('is not fooled by a brace inside a string', () => {
    const out = salvageObjects('{"why":"the guidance {raised} again","i":0}');
    expect(out).toHaveLength(1);
    expect((out[0] as { why: string }).why).toBe('the guidance {raised} again');
  });

  it('handles an escaped quote inside a string', () => {
    const out = salvageObjects('{"why":"they said \\"beat\\" twice","i":0}');
    expect((out[0] as { why: string }).why).toBe('they said "beat" twice');
  });

  it('returns nothing for prose', () => {
    expect(salvageObjects('I think the first headline is bullish.')).toEqual([]);
  });

  it('survives a stray closing brace without going negative', () => {
    expect(salvageObjects('} {"i":0}')).toHaveLength(1);
  });
});

describe('triageNews on a truncated reply', () => {
  it('salvages the ratings that arrived instead of discarding the batch', async () => {
    // This is what the live daemon produced on a 23-symbol batch: the reply ran
    // past the output budget and stopped mid-object.
    const truncated =
      '```json\n{"items":[' +
      '{"i":0,"materiality":80,"direction":0.9,"category":"MA","why":"acquisition"},' +
      '{"i":1,"materiality":15,"direction":0,"category":"NOISE","why":"recap"},' +
      '{"i":2,"materiality":60,"direction":-0.7,"cate';
    const out = await triageNews(['a', 'b', 'c'], { budget: budget(), log, ask: reply(truncated) });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.items).toHaveLength(2);
      expect(out.items[0]!.category).toBe('MA');
    }
  });

  it('still fails when there is nothing to salvage', async () => {
    const out = await triageNews(['a'], { budget: budget(), log, ask: reply('no json at all here') });
    expect(out.ok).toBe(false);
  });
});

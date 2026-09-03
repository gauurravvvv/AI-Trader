import { describe, it, expect } from 'vitest';
import { scoreSue } from './scorer.js';
import type { VerifiedEarningsRead } from './earnings-reader.js';

const read = (over: Partial<VerifiedEarningsRead> = {}): VerifiedEarningsRead => ({
  guidanceDelta: 'RAISED',
  guidanceEvidence: 'We are raising our full-year outlook.',
  languageTone: 0.6,
  hedgingDensity: 0.2,
  momentumShift: 0.8,
  riskFlags: [],
  keyQuotes: [],
  oneLineWhy: 'strong beat, guidance raised',
  confidence: 85,
  dataGaps: [],
  fabricatedQuotes: [],
  model: 'sonnet',
  costUsd: '0.03',
  latencyMs: 9000,
  ...over,
});

describe('scoreSue', () => {
  it('scores a strong beat with raised guidance above the gate', () => {
    const r = scoreSue({ read: read(), numericSue: 2.5 });
    expect(Number(r.sue)).toBeGreaterThan(1.5);
    expect(r.passesGate).toBe(true);
    expect(r.direction).toBe('long');
  });

  it('scores a miss with lowered guidance below the gate', () => {
    const r = scoreSue({
      read: read({ momentumShift: -0.8, languageTone: -0.5, guidanceDelta: 'LOWERED' }),
      numericSue: -2,
    });
    expect(Number(r.sue)).toBeLessThan(0);
    expect(r.passesGate).toBe(false);
    expect(r.direction).toBe('none');
  });

  it('is long-only — a strongly negative score does not become a short', () => {
    const r = scoreSue({
      read: read({ momentumShift: -1, languageTone: -1, guidanceDelta: 'WITHDRAWN' }),
      numericSue: -5,
    });
    expect(r.direction).toBe('none');
  });

  it('redistributes the numeric weight when consensus is unknown, not zeroes it', () => {
    // The property that matters: a missing numeric term must not silently
    // shrink the score. Treating "unknown" as "no surprise" would apply only
    // the 0.3 + 0.2 text/guidance weights, losing half the signal. Redistributed
    // to 0.6 + 0.4, the same read scores about twice as high.
    const redistributed = Number(scoreSue({ read: read(), numericSue: null }).sue);
    const withNumericAsZero = Number(scoreSue({ read: read(), numericSue: 0 }).sue);
    expect(redistributed).toBeCloseTo(withNumericAsZero * 2, 3);
    expect(scoreSue({ read: read(), numericSue: null }).penalties.join()).toMatch(/no consensus/);
  });

  it('halves the score when the model fabricated a quote', () => {
    const clean = scoreSue({ read: read(), numericSue: 2.5 });
    const dirty = scoreSue({ read: read({ fabricatedQuotes: ['made up'] }), numericSue: 2.5 });
    expect(Number(dirty.sue)).toBeCloseTo(Number(clean.sue) / 2, 4);
    expect(dirty.penalties.join()).toMatch(/fabricated/);
  });

  it('scales the score down on low model confidence', () => {
    const hi = scoreSue({ read: read({ confidence: 85 }), numericSue: 2.5 });
    const lo = scoreSue({ read: read({ confidence: 30 }), numericSue: 2.5 });
    expect(Number(lo.sue)).toBeLessThan(Number(hi.sue));
    expect(lo.penalties.join()).toMatch(/confidence/);
  });

  it('damps the score when the filing had many data gaps', () => {
    const gaps = [1, 2, 3].map((i) => ({ field: `f${String(i)}`, reason: 'absent' }));
    const r = scoreSue({ read: read({ dataGaps: gaps }), numericSue: 2.5 });
    expect(r.penalties.join()).toMatch(/data gaps/);
  });

  it('bounds the risk-flag penalty so a verbose read cannot veto any score', () => {
    // Unbounded subtraction would let 20 chatty flags invert a strong signal.
    const clean = Number(scoreSue({ read: read(), numericSue: 4 }).sue);
    const many = Number(
      scoreSue({ read: read({ riskFlags: Array(20).fill('a concern') }), numericSue: 4 }).sue,
    );
    expect(many).toBeGreaterThan(clean * 0.55);
    expect(many).toBeGreaterThan(0);
  });

  it('discounts for each risk flag the filing raised', () => {
    const clean = scoreSue({ read: read(), numericSue: 2.5 });
    const flagged = scoreSue({
      read: read({ riskFlags: ['goodwill impairment', 'CFO departure'] }),
      numericSue: 2.5,
    });
    expect(Number(flagged.sue)).toBeLessThan(Number(clean.sue));
    expect(flagged.penalties.join()).toMatch(/risk flag/);
    // discount, never inversion
    expect(Number(flagged.sue)).toBeGreaterThan(0);
  });

  it('penalises hedging even when momentum and tone are positive', () => {
    const calm = scoreSue({ read: read({ hedgingDensity: 0.1 }), numericSue: 2.5 });
    const hedged = scoreSue({ read: read({ hedgingDensity: 0.9 }), numericSue: 2.5 });
    expect(Number(hedged.sue)).toBeLessThan(Number(calm.sue));
  });

  it('reports every component and its applied weight', () => {
    const r = scoreSue({ read: read(), numericSue: 2 });
    expect(r.components.map((c) => c.name)).toEqual([
      'numericSurprise', 'textSurprise', 'guidance',
    ]);
    const total = r.components.reduce((a, c) => a + c.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('respects a custom threshold', () => {
    const inputs = { read: read(), numericSue: 1.0 };
    expect(scoreSue(inputs, 0.5).passesGate).toBe(true);
    expect(scoreSue(inputs, 5.0).passesGate).toBe(false);
  });
});

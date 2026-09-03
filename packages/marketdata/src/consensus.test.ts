import { describe, it, expect } from 'vitest';
import { standardisedSue, type QuarterSurprise } from './consensus.js';

const hist = (diffs: number[]): QuarterSurprise[] =>
  diffs.map((d, i) => ({
    quarterEnd: `2026-0${String(i + 1)}-01`,
    epsActual: 1 + d,
    epsEstimate: 1,
    epsDifference: d,
    surprisePercent: d,
  }));

describe('standardisedSue', () => {
  it('divides the surprise by the firm own surprise volatility', () => {
    // NVDA-like: consistently beats by 4-13c, so a 13c beat is ~2 stdev
    const r = standardisedSue(2.22, 2.09, hist([0.04, 0.08, 0.1, 0.13]));
    expect(r.basis).toBe('history');
    expect(r.sue).toBeGreaterThan(1);
  });

  it('scores the SAME dollar beat lower at a high-variance firm', () => {
    const steady = standardisedSue(1.1, 1.0, hist([0.01, 0.02, 0.01, 0.02]));
    const wild = standardisedSue(1.1, 1.0, hist([-0.5, 0.6, -0.4, 0.5]));
    // A 10c beat is remarkable for the steady firm, noise for the wild one.
    expect(steady.sue).toBeGreaterThan(wild.sue);
  });

  it('falls back and says so when there is too little history', () => {
    const r = standardisedSue(1.1, 1.0, hist([0.01]));
    expect(r.basis).toBe('fallback');
    expect(Number.isFinite(r.sue)).toBe(true);
  });

  it('does not divide by zero on a firm that always hits exactly', () => {
    const r = standardisedSue(1.05, 1.0, hist([0, 0, 0, 0]));
    expect(Number.isFinite(r.sue)).toBe(true);
    expect(r.stdev).toBeGreaterThan(0);
  });

  it('is negative on a miss', () => {
    expect(standardisedSue(0.9, 1.0, hist([0.01, 0.02, 0.01, 0.02])).sue).toBeLessThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { estimateCost, estimateTokens } from './pricing.js';

describe('estimateCost', () => {
  it('prices haiku at $1/$5 per million', () => {
    expect(Number(estimateCost('haiku', 1_000_000, 1_000_000))).toBeCloseTo(6, 6);
  });

  it('prices sonnet at $3/$15 per million', () => {
    expect(Number(estimateCost('sonnet', 1_000_000, 1_000_000))).toBeCloseTo(18, 6);
  });

  it('prices a realistic earnings read near nine cents', () => {
    // 20k filing in, 1.2k structured out, sonnet
    const c = Number(estimateCost('sonnet', 20_000, 1_200));
    expect(c).toBeGreaterThan(0.07);
    expect(c).toBeLessThan(0.10);
  });

  it('returns a decimal string, never a float', () => {
    expect(typeof estimateCost('haiku', 1000, 100)).toBe('string');
  });
});

describe('estimateTokens', () => {
  it('estimates at roughly four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('hi')).toBeGreaterThan(0);
  });
});

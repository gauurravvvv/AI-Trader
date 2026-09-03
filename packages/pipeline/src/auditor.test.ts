import { describe, it, expect } from 'vitest';
import { tierFor, AuditSchema } from './auditor.js';

describe('tierFor', () => {
  it('maps totals to tiers at the documented boundaries', () => {
    expect(tierFor(100)).toBe('VERY_HIGH');
    expect(tierFor(85)).toBe('VERY_HIGH');
    expect(tierFor(84)).toBe('HIGH');
    expect(tierFor(70)).toBe('HIGH');
    expect(tierFor(69)).toBe('MEDIUM');
    expect(tierFor(55)).toBe('MEDIUM');
    expect(tierFor(54)).toBe('LOW');
    expect(tierFor(40)).toBe('LOW');
    expect(tierFor(39)).toBe('VERY_LOW');
    expect(tierFor(0)).toBe('VERY_LOW');
  });
});

describe('AuditSchema', () => {
  const valid = {
    dataQuality: 15, methodology: 16, signalConsistency: 14,
    riskCoverage: 13, reasoningTransparency: 15,
    verdict: 'PROCEED', oneLineJudgement: 'sound',
  };

  it('accepts a well-formed audit and defaults the arrays', () => {
    const r = AuditSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.redFlags).toEqual([]);
  });

  it('rejects a dimension above 20', () => {
    expect(AuditSchema.safeParse({ ...valid, dataQuality: 21 }).success).toBe(false);
  });

  it('rejects an unknown verdict', () => {
    expect(AuditSchema.safeParse({ ...valid, verdict: 'MAYBE' }).success).toBe(false);
  });
});

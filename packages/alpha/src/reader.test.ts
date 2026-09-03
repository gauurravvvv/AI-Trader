import { describe, it, expect } from 'vitest';
import { verifyQuotes } from './earnings-reader.js';
import type { EarningsRead } from './earnings-reader.js';

const base: EarningsRead = {
  guidanceDelta: 'RAISED', guidanceEvidence: '', languageTone: 0.5,
  hedgingDensity: 0.2, momentumShift: 0.6, riskFlags: [],
  keyQuotes: [], oneLineWhy: 'x', confidence: 80, dataGaps: [],
};

const SOURCE =
  'NVIDIA Announces Financial Results for Second Quarter Fiscal 2027.\n' +
  'Revenue of $96.2 billion, up 106% from a year ago.\n' +
  'Data Center revenue of $89.0 billion, up 117%   from a year ago.';

describe('verifyQuotes', () => {
  it('keeps a verbatim quote', () => {
    const r = verifyQuotes({ ...base, keyQuotes: [{ quote: 'Revenue of $96.2 billion', why: 'headline' }] }, SOURCE);
    expect(r.kept).toHaveLength(1);
    expect(r.fabricated).toHaveLength(0);
  });

  it('discards a quote that is not in the document', () => {
    const r = verifyQuotes({ ...base, keyQuotes: [{ quote: 'Revenue of $200 billion', why: 'invented' }] }, SOURCE);
    expect(r.kept).toHaveLength(0);
    expect(r.fabricated).toEqual(['Revenue of $200 billion']);
  });

  it('tolerates whitespace differences the model introduces', () => {
    const r = verifyQuotes({ ...base, keyQuotes: [{ quote: 'up 117% from a year ago', why: 'dc' }] }, SOURCE);
    expect(r.kept).toHaveLength(1);
  });

  it('tolerates typographic quote and dash substitution', () => {
    const src = 'Management said “we expect growth” and noted a record—by far.';
    const r = verifyQuotes({ ...base, keyQuotes: [{ quote: '"we expect growth"', why: 'tone' }] }, src);
    expect(r.kept).toHaveLength(1);
  });

  it('rejects a too-short fragment that would match almost anything', () => {
    const r = verifyQuotes({ ...base, keyQuotes: [{ quote: 'up', why: 'noise' }] }, SOURCE);
    expect(r.fabricated).toEqual(['up']);
  });

  it('separates real from invented in a mixed set', () => {
    const r = verifyQuotes({
      ...base,
      keyQuotes: [
        { quote: 'Revenue of $96.2 billion', why: 'real' },
        { quote: 'margins collapsed entirely', why: 'invented' },
      ],
    }, SOURCE);
    expect(r.kept).toHaveLength(1);
    expect(r.fabricated).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { universeFor, edgarWatchable, US_UNIVERSE } from './universe.js';

describe('universe', () => {
  it('filters by market', () => {
    const us = universeFor(['US']);
    expect(us.every((e) => e.market === 'US')).toBe(true);
    expect(us.length).toBe(US_UNIVERSE.length);
  });

  it('combines markets', () => {
    const both = universeFor(['US', 'CRYPTO']);
    expect(both.some((e) => e.market === 'CRYPTO')).toBe(true);
    expect(both.some((e) => e.market === 'US')).toBe(true);
  });

  it('edgarWatchable keeps only names with a CIK', () => {
    const w = edgarWatchable(universeFor(['US', 'CRYPTO', 'IN']));
    expect(w.every((e) => e.cik !== null && e.cik.length > 0)).toBe(true);
    // crypto and Indian names have no EDGAR presence
    expect(w.every((e) => e.market === 'US')).toBe(true);
  });

  it('every US entry has a CIK — a missing one silently drops the name', () => {
    expect(US_UNIVERSE.every((e) => e.cik !== null)).toBe(true);
  });
});

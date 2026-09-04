import { describe, it, expect } from 'vitest';
import { PAPER_ENDPOINTS, VENUE_MARKET, resolveEndpoint , isSimulated } from './endpoints.js';

describe('PAPER_ENDPOINTS', () => {
  it('contains exactly the venues the type declares — no more', () => {
    expect(Object.keys(PAPER_ENDPOINTS).sort()).toEqual([
      'alpaca-paper',
      'binance-testnet',
      'india-sim',
      'sim-crypto',
      'sim-india',
      'sim-us',
    ]);
  });

  it('marks every sim venue as unreachable and every paper venue as not', () => {
    expect(isSimulated('sim-us')).toBe(true);
    expect(isSimulated('sim-crypto')).toBe(true);
    expect(isSimulated('sim-india')).toBe(true);
    expect(isSimulated('alpaca-paper')).toBe(false);
    expect(isSimulated('binance-testnet')).toBe(false);
  });

  it('gives every sim venue an internal:// endpoint that no client can dial', () => {
    for (const v of ['sim-us', 'sim-crypto', 'sim-india'] as const) {
      expect(PAPER_ENDPOINTS[v]).toMatch(/^internal:\/\//);
    }
  });

  it('maps US to Alpaca paper', () => {
    expect(resolveEndpoint('alpaca-paper')).toBe('https://paper-api.alpaca.markets');
    expect(VENUE_MARKET['alpaca-paper']).toBe('US');
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(PAPER_ENDPOINTS)).toBe(true);
  });

  it('throws on an unknown venue rather than returning undefined', () => {
    // @ts-expect-error deliberately invalid
    expect(() => resolveEndpoint('alpaca-live')).toThrow(/unknown venue/i);
  });
});

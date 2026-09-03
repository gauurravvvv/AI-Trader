import { describe, it, expect } from 'vitest';
import { PAPER_ENDPOINTS, VENUE_MARKET, resolveEndpoint } from './endpoints.js';

describe('PAPER_ENDPOINTS', () => {
  it('contains exactly the three paper venues', () => {
    expect(Object.keys(PAPER_ENDPOINTS).sort())
      .toEqual(['alpaca-paper', 'binance-testnet', 'india-sim']);
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

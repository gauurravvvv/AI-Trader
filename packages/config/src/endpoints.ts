export type VenueId = 'alpaca-paper' | 'binance-testnet' | 'india-sim';
export type MarketId = 'US' | 'CRYPTO' | 'IN';

/**
 * INV-1: the complete, frozen set of endpoints this system may ever reach.
 * Adding a live host here is a licence to lose money and must be rejected in
 * review. `no-live-endpoints.test.ts` fails the build if one appears anywhere.
 */
export const PAPER_ENDPOINTS = Object.freeze({
  'alpaca-paper': 'https://paper-api.alpaca.markets',
  'binance-testnet': 'https://testnet.binance.vision',
  'india-sim': 'internal://india-sim',
} as const satisfies Record<VenueId, string>);

export const VENUE_MARKET = Object.freeze({
  'alpaca-paper': 'US',
  'binance-testnet': 'CRYPTO',
  'india-sim': 'IN',
} as const satisfies Record<VenueId, MarketId>);

export function resolveEndpoint(venue: VenueId): string {
  const url = PAPER_ENDPOINTS[venue];
  if (url === undefined) throw new Error(`Unknown venue: ${String(venue)}`);
  return url;
}

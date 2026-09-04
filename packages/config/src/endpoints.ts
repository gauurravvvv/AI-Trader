export type VenueId =
  // Simulated venues. These are what the system actually trades: fills are
  // modelled locally against live quotes, so there is no signup, no API key and
  // no counterparty. `internal://` is not a reachable scheme — that is the point.
  | 'sim-us'
  | 'sim-crypto'
  | 'sim-india'
  // Real paper venues, kept for the adapters that will need them. Reaching one
  // requires an account the operator must create deliberately.
  | 'alpaca-paper'
  | 'binance-testnet'
  | 'india-sim';

export type MarketId = 'US' | 'CRYPTO' | 'IN';

/**
 * INV-1: the complete, frozen set of endpoints this system may ever reach.
 * Adding a live host here is a licence to lose money and must be rejected in
 * review. `no-live-endpoints.test.ts` fails the build if one appears anywhere.
 */
export const PAPER_ENDPOINTS = Object.freeze({
  'sim-us': 'internal://sim-us',
  'sim-crypto': 'internal://sim-crypto',
  'sim-india': 'internal://sim-india',
  'alpaca-paper': 'https://paper-api.alpaca.markets',
  'binance-testnet': 'https://testnet.binance.vision',
  'india-sim': 'internal://india-sim',
} as const satisfies Record<VenueId, string>);

export const VENUE_MARKET = Object.freeze({
  'sim-us': 'US',
  'sim-crypto': 'CRYPTO',
  'sim-india': 'IN',
  'alpaca-paper': 'US',
  'binance-testnet': 'CRYPTO',
  'india-sim': 'IN',
} as const satisfies Record<VenueId, MarketId>);

/** True when the venue is modelled locally and reaches no network at all. */
export function isSimulated(venue: VenueId): boolean {
  return PAPER_ENDPOINTS[venue].startsWith('internal://');
}

export function resolveEndpoint(venue: VenueId): string {
  const url = PAPER_ENDPOINTS[venue];
  if (url === undefined) throw new Error(`Unknown venue: ${String(venue)}`);
  return url;
}

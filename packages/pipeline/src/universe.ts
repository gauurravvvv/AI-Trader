import type { MarketId } from '@aegis/config';

export interface UniverseEntry {
  symbol: string;
  /** SEC CIK. Null for non-US names, which have no EDGAR presence. */
  cik: string | null;
  market: MarketId;
  name: string;
}

/**
 * The watch universe.
 *
 * Deliberately small. Post-earnings drift is strongest in names with lower
 * institutional ownership, but the US mega-caps are where free data is most
 * reliable, so v1 trades the liquid names and treats that as a conservative
 * starting point rather than the theoretically optimal one.
 */
export const US_UNIVERSE: UniverseEntry[] = [
  { symbol: 'NVDA', cik: '1045810', market: 'US', name: 'NVIDIA' },
  { symbol: 'AAPL', cik: '320193', market: 'US', name: 'Apple' },
  { symbol: 'MSFT', cik: '789019', market: 'US', name: 'Microsoft' },
  { symbol: 'GOOGL', cik: '1652044', market: 'US', name: 'Alphabet' },
  { symbol: 'AMZN', cik: '1018724', market: 'US', name: 'Amazon' },
  { symbol: 'META', cik: '1326801', market: 'US', name: 'Meta Platforms' },
  { symbol: 'AMD', cik: '2488', market: 'US', name: 'AMD' },
  { symbol: 'TSLA', cik: '1318605', market: 'US', name: 'Tesla' },
  { symbol: 'AVGO', cik: '1730168', market: 'US', name: 'Broadcom' },
  { symbol: 'CRM', cik: '1108524', market: 'US', name: 'Salesforce' },
  { symbol: 'ORCL', cik: '1341439', market: 'US', name: 'Oracle' },
  { symbol: 'ADBE', cik: '796343', market: 'US', name: 'Adobe' },
  { symbol: 'NFLX', cik: '1065280', market: 'US', name: 'Netflix' },
  { symbol: 'INTC', cik: '50863', market: 'US', name: 'Intel' },
  { symbol: 'MU', cik: '723125', market: 'US', name: 'Micron' },
];

export const CRYPTO_UNIVERSE: UniverseEntry[] = [
  { symbol: 'BTC', cik: null, market: 'CRYPTO', name: 'Bitcoin' },
  { symbol: 'ETH', cik: null, market: 'CRYPTO', name: 'Ethereum' },
  { symbol: 'SOL', cik: null, market: 'CRYPTO', name: 'Solana' },
];

export const IN_UNIVERSE: UniverseEntry[] = [
  { symbol: 'RELIANCE', cik: null, market: 'IN', name: 'Reliance Industries' },
  { symbol: 'TCS', cik: null, market: 'IN', name: 'Tata Consultancy Services' },
  { symbol: 'INFY', cik: null, market: 'IN', name: 'Infosys' },
  { symbol: 'HDFCBANK', cik: null, market: 'IN', name: 'HDFC Bank' },
  { symbol: 'ICICIBANK', cik: null, market: 'IN', name: 'ICICI Bank' },
];

export function universeFor(markets: MarketId[]): UniverseEntry[] {
  const all = [...US_UNIVERSE, ...CRYPTO_UNIVERSE, ...IN_UNIVERSE];
  return all.filter((e) => markets.includes(e.market));
}

/** Only US names have EDGAR filings to poll. */
export function edgarWatchable(entries: UniverseEntry[]): (UniverseEntry & { cik: string })[] {
  return entries.filter((e): e is UniverseEntry & { cik: string } => e.cik !== null);
}

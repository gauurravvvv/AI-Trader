import type { VenueId, MarketId } from '@aegis/config';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

/**
 * Whether an order adds risk or removes it.
 *
 * Side alone cannot say. Once shorting exists a sell is an entry as often as
 * an exit, and every gate that read `side === 'sell'` as "this is an exit" was
 * about to start waving short entries straight through the sizing checks.
 */
export type OrderIntent = 'open' | 'close';
export type OrderStatus = 'pending' | 'submitted' | 'partial' | 'filled' | 'cancelled' | 'rejected';

export interface OrderRequest {
  /** Defaults to 'open' for a buy and 'close' for a sell — the pre-short behaviour. */
  intent?: OrderIntent;
  /** Idempotency key: `${decisionId}:${rungIndex}`. Resubmitting must be a no-op. */
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: string; // decimal string — never a JS number
  limitPrice?: string;
}

export interface VenueOrder {
  venueOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: string;
  filledQty: string;
  avgFillPrice: string | null;
  status: OrderStatus;
  submittedAt: string;
}

export interface FillEvent {
  venueOrderId: string;
  venueFillId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: string;
  price: string;
  fee: string;
  filledAt: string;
}

export interface VenuePosition {
  symbol: string;
  qty: string;
  avgCost: string;
}

export interface Account {
  equity: string;
  cash: string;
  currency: string;
}

export interface Quote {
  symbol: string;
  last: string;
  bid: string;
  ask: string;
  volume: string;
  at: string;
  /**
   * True when the bid/ask was estimated rather than quoted.
   *
   * Yahoo reports indicative spreads after hours that can be two orders of
   * magnitude too wide, so an implausible one is replaced with a tier-based
   * estimate. The flag travels with the quote because a decision priced off a
   * synthesised spread is weaker than one priced off a real book, and that is
   * only knowable here.
   */
  synthetic?: boolean;
}

export interface VenueConstraints {
  tickSize: string;
  lotSize: string;
  minNotional: string;
  supportsFractional: boolean;
  supportsShort: boolean;
}

export interface SessionCalendar {
  isOpen(at: Date): boolean;
}

export interface ReconciliationReport {
  matched: boolean;
  breaks: { symbol: string; ledgerQty: string; venueQty: string }[];
}

export type Unsubscribe = () => void;

export interface BrokerAdapter {
  readonly venue: VenueId;
  readonly market: MarketId;
  /** INV-1: the type has no other member. */
  readonly mode: 'paper';

  getAccount(): Promise<Account>;
  getPositions(): Promise<VenuePosition[]>;
  getQuote(symbol: string): Promise<Quote | null>;
  submitOrder(req: OrderRequest): Promise<VenueOrder>;
  cancelOrder(venueOrderId: string): Promise<void>;
  listOpenOrders(): Promise<VenueOrder[]>;
  streamFills(onEvent: (e: FillEvent) => void): Unsubscribe;
  reconcile(ledger: VenuePosition[]): Promise<ReconciliationReport>;

  readonly calendar: SessionCalendar;
  readonly constraints: VenueConstraints;
}

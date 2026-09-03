import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import type { VenueId, MarketId } from '@aegis/config';
import type {
  Account,
  BrokerAdapter,
  FillEvent,
  OrderRequest,
  Quote,
  ReconciliationReport,
  SessionCalendar,
  Unsubscribe,
  VenueConstraints,
  VenueOrder,
  VenuePosition,
} from './types.js';

export interface PriceSource {
  /** Latest quote, or null when unavailable. */
  quote(symbol: string): Promise<Quote | null>;
}

export interface SimCosts {
  /** Fraction of the spread paid on entry. 0.5 = cross half the spread. */
  spreadShare: number;
  /** Floor on slippage as a fraction of price. */
  minSlippage: number;
  /** Commission as a fraction of notional. */
  commission: number;
  /** Fixed per-order fee in account currency. */
  perOrderFee: string;
}

/** US default: no commission, but IEX-vs-SIP divergence gets an explicit penalty. */
export const US_COSTS: SimCosts = {
  spreadShare: 0.5,
  minSlippage: 0.0008, // 8bp — covers the IEX/SIP gap on a free paper feed
  commission: 0,
  perOrderFee: '0',
};

/** India: the full statutory stack is material and must not be waved away. */
export const IN_COSTS: SimCosts = {
  spreadShare: 0.5,
  minSlippage: 0.0005,
  // brokerage + STT + exchange charges + GST + stamp duty, blended
  commission: 0.00115,
  perOrderFee: '20',
};

export const CRYPTO_COSTS: SimCosts = {
  spreadShare: 0.5,
  minSlippage: 0.0005,
  commission: 0.001, // taker
  perOrderFee: '0',
};

/**
 * In-process paper venue.
 *
 * Deliberately pessimistic. A simulator that produces better results than
 * reality is not a simulator, it is a lie generator — so every fill pays the
 * spread, a slippage floor, and the venue's real cost stack, and no fill is
 * ever priced better than the quote that was on screen.
 *
 * This is the default venue: it needs no signup, no API key, and no network,
 * so the whole system is runnable and testable end to end out of the box.
 */
export class SimAdapter implements BrokerAdapter {
  readonly mode = 'paper' as const;

  private readonly orders = new Map<string, VenueOrder>(); // clientOrderId -> order
  private readonly positions = new Map<string, { qty: Decimal; cost: Decimal }>();
  private readonly listeners = new Set<(e: FillEvent) => void>();
  private cash: Decimal;

  constructor(
    readonly venue: VenueId,
    readonly market: MarketId,
    private readonly prices: PriceSource,
    private readonly costs: SimCosts,
    startingCash: string,
    readonly constraints: VenueConstraints,
    readonly calendar: SessionCalendar,
  ) {
    this.cash = new Decimal(startingCash);
  }

  async getAccount(): Promise<Account> {
    let equity = this.cash;
    for (const [symbol, p] of this.positions) {
      const q = await this.prices.quote(symbol);
      const mark = q ? new Decimal(q.last) : p.cost;
      equity = equity.plus(p.qty.times(mark));
    }
    return {
      equity: equity.toFixed(2),
      cash: this.cash.toFixed(2),
      currency: this.market === 'IN' ? 'INR' : 'USD',
    };
  }

  async getPositions(): Promise<VenuePosition[]> {
    return [...this.positions.entries()]
      .filter(([, p]) => p.qty.gt(0))
      .map(([symbol, p]) => ({
        symbol,
        qty: p.qty.toString(),
        avgCost: p.qty.isZero() ? '0' : p.cost.div(p.qty).toFixed(6),
      }));
  }

  async getQuote(symbol: string): Promise<Quote | null> {
    return this.prices.quote(symbol);
  }

  /**
   * Effective fill price. Always worse than the quote, never better.
   * Slippage scales with participation rate — a large order in a thin name
   * pays superlinearly, which is the whole reason position sizing matters.
   */
  private fillPrice(q: Quote, side: 'buy' | 'sell', qty: Decimal): Decimal {
    const bid = new Decimal(q.bid);
    const ask = new Decimal(q.ask);
    const mid = bid.plus(ask).div(2);
    const halfSpread = ask.minus(bid).div(2).times(this.costs.spreadShare);

    const volume = new Decimal(q.volume);
    const participation = volume.gt(0) ? qty.div(volume) : new Decimal(0.01);
    // superlinear in participation rate
    const impact = participation.pow(1.5).times(2);
    const slip = Decimal.max(this.costs.minSlippage, impact).times(mid);

    const worse = halfSpread.plus(slip);
    return side === 'buy' ? mid.plus(worse) : mid.minus(worse);
  }

  async submitOrder(req: OrderRequest): Promise<VenueOrder> {
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return existing; // idempotent — a restart must not double-place

    const q = await this.prices.quote(req.symbol);
    if (!q) {
      const rejected: VenueOrder = {
        venueOrderId: randomUUID(),
        clientOrderId: req.clientOrderId,
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        qty: req.qty,
        filledQty: '0',
        avgFillPrice: null,
        status: 'rejected',
        submittedAt: new Date().toISOString(),
      };
      this.orders.set(req.clientOrderId, rejected);
      return rejected;
    }

    const qty = new Decimal(req.qty);
    const price = this.fillPrice(q, req.side, qty);

    // A limit order only fills if the effective price respects the limit.
    if (req.type === 'limit' && req.limitPrice !== undefined) {
      const lim = new Decimal(req.limitPrice);
      const wouldFill = req.side === 'buy' ? price.lte(lim) : price.gte(lim);
      if (!wouldFill) {
        const open: VenueOrder = {
          venueOrderId: randomUUID(),
          clientOrderId: req.clientOrderId,
          symbol: req.symbol,
          side: req.side,
          type: req.type,
          qty: req.qty,
          filledQty: '0',
          avgFillPrice: null,
          status: 'submitted',
          submittedAt: new Date().toISOString(),
        };
        this.orders.set(req.clientOrderId, open);
        return open;
      }
    }

    const notional = qty.times(price);
    const fee = notional.times(this.costs.commission).plus(this.costs.perOrderFee);

    const order: VenueOrder = {
      venueOrderId: randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      filledQty: req.qty,
      avgFillPrice: price.toFixed(6),
      status: 'filled',
      submittedAt: new Date().toISOString(),
    };
    this.orders.set(req.clientOrderId, order);

    const cur = this.positions.get(req.symbol) ?? { qty: new Decimal(0), cost: new Decimal(0) };
    if (req.side === 'buy') {
      this.positions.set(req.symbol, { qty: cur.qty.plus(qty), cost: cur.cost.plus(notional) });
      this.cash = this.cash.minus(notional).minus(fee);
    } else {
      const avg = cur.qty.gt(0) ? cur.cost.div(cur.qty) : new Decimal(0);
      this.positions.set(req.symbol, {
        qty: cur.qty.minus(qty),
        cost: Decimal.max(0, cur.cost.minus(qty.times(avg))),
      });
      this.cash = this.cash.plus(notional).minus(fee);
    }

    const fill: FillEvent = {
      venueOrderId: order.venueOrderId,
      venueFillId: randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      price: price.toFixed(6),
      fee: fee.toFixed(6),
      // Never the decision-time price: a real fill lands after a round trip.
      filledAt: new Date(Date.now() + 300).toISOString(),
    };
    queueMicrotask(() => {
      for (const l of this.listeners) l(fill);
    });

    return order;
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    for (const [k, o] of this.orders) {
      if (o.venueOrderId === venueOrderId && o.status === 'submitted') {
        this.orders.set(k, { ...o, status: 'cancelled' });
      }
    }
  }

  async listOpenOrders(): Promise<VenueOrder[]> {
    return [...this.orders.values()].filter((o) => o.status === 'submitted');
  }

  streamFills(onEvent: (e: FillEvent) => void): Unsubscribe {
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  async reconcile(ledger: VenuePosition[]): Promise<ReconciliationReport> {
    const venue = await this.getPositions();
    const bySymbol = new Map(venue.map((p) => [p.symbol, p.qty]));
    const breaks: ReconciliationReport['breaks'] = [];
    for (const symbol of new Set([...ledger.map((l) => l.symbol), ...bySymbol.keys()])) {
      const ledgerQty = ledger.find((l) => l.symbol === symbol)?.qty ?? '0';
      const venueQty = bySymbol.get(symbol) ?? '0';
      if (!new Decimal(ledgerQty).minus(venueQty).abs().lt(1e-8)) {
        breaks.push({ symbol, ledgerQty, venueQty });
      }
    }
    return { matched: breaks.length === 0, breaks };
  }
}

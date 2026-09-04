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
/**
 * Split an order into slices when it is large relative to the bar's volume.
 *
 * A real order for a meaningful share of the day's volume does not fill at one
 * price in one instant: it works through the book over minutes, and each slice
 * pays a worse price than the last. Filling it whole at a single price is the
 * most flattering assumption a simulator can make, and it is the one that makes
 * position sizing look free.
 *
 * Below the threshold an order is one slice, which is both realistic and keeps
 * the common case simple.
 */
export function sliceOrder(
  qty: Decimal,
  volume: Decimal,
  maxParticipationPerSlice = 0.005,
  maxSlices = 8,
): Decimal[] {
  if (qty.lte(0)) return [];
  if (volume.lte(0)) return [qty];

  const perSlice = volume.times(maxParticipationPerSlice);
  if (perSlice.lte(0) || qty.lte(perSlice)) return [qty];

  const wanted = qty.div(perSlice).ceil().toNumber();
  const n = Math.min(wanted, maxSlices);
  const base = qty.div(n).floor();

  const slices: Decimal[] = [];
  let placed = new Decimal(0);
  for (let i = 0; i < n - 1; i += 1) {
    if (base.lte(0)) break;
    slices.push(base);
    placed = placed.plus(base);
  }
  // The last slice takes the remainder, so no share is lost or invented.
  const rest = qty.minus(placed);
  if (rest.gt(0)) slices.push(rest);
  return slices.length > 0 ? slices : [qty];
}

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
    // Signed quantity times mark works for both directions: a short contributes
    // negatively, so a rising price correctly reduces equity.
    let equity = this.cash;
    for (const [symbol, p] of this.positions) {
      if (p.qty.isZero()) continue;
      const q = await this.prices.quote(symbol);
      const mark = q ? new Decimal(q.last) : (p.qty.isZero() ? new Decimal(0) : p.cost.div(p.qty));
      equity = equity.plus(p.qty.times(mark));
    }
    return {
      equity: equity.toFixed(2),
      cash: this.cash.toFixed(2),
      currency: this.market === 'IN' ? 'INR' : 'USD',
    };
  }

  async getPositions(): Promise<VenuePosition[]> {
    // A short is a position. Filtering on `> 0` hid them entirely, which meant
    // reconciliation would have reported a phantom break on every short.
    return [...this.positions.entries()]
      .filter(([, p]) => !p.qty.isZero())
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
    const held = this.positions.get(req.symbol)?.qty ?? new Decimal(0);
    if (!this.constraints.supportsShort && req.side === 'sell' && qty.gt(held)) {
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
    // Each slice is priced on the cumulative quantity worked so far, so later
    // slices pay for the impact the earlier ones already caused.
    const slices = sliceOrder(qty, new Decimal(q.volume));
    let worked = new Decimal(0);
    const priced = slices.map((sliceQty) => {
      worked = worked.plus(sliceQty);
      return { qty: sliceQty, price: this.fillPrice(q, req.side, worked) };
    });
    const grossValue = priced.reduce((a, s) => a.plus(s.price.times(s.qty)), new Decimal(0));
    const price = qty.gt(0) ? grossValue.div(qty) : new Decimal(0);

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

    // Signed quantity: negative is short. Cost is tracked as a signed total so
    // the average works out for either direction — a short's "cost" is what it
    // was sold for, and covering below that is the profit.
    const cur = this.positions.get(req.symbol) ?? { qty: new Decimal(0), cost: new Decimal(0) };
    const signed = req.side === 'buy' ? qty : qty.negated();
    const avg = cur.qty.isZero() ? new Decimal(0) : cur.cost.div(cur.qty);
    const crossesZero = !cur.qty.isZero() && cur.qty.s !== signed.s && signed.abs().gt(cur.qty.abs());

    let nextQty = cur.qty.plus(signed);
    let nextCost: Decimal;
    if (cur.qty.isZero() || cur.qty.s === signed.s) {
      // Opening or adding in the same direction.
      nextCost = cur.cost.plus(signed.times(price));
    } else if (crossesZero) {
      // Reduced past flat and opened the other way: the residual is a new
      // position at this price, not the remains of the old one.
      nextCost = nextQty.times(price);
    } else {
      // Reducing: keep the original average on what is left.
      nextCost = nextQty.times(avg);
    }
    if (nextQty.isZero()) nextCost = new Decimal(0);

    this.positions.set(req.symbol, { qty: nextQty, cost: nextCost });
    // Buying spends cash, selling raises it, in both directions.
    this.cash = req.side === 'buy'
      ? this.cash.minus(notional).minus(fee)
      : this.cash.plus(notional).minus(fee);

    // One event per slice. The fee is apportioned by value so the parts sum to
    // the whole, and each slice lands later than the last — a worked order takes
    // time, and a ledger that sees them all at one instant has not modelled it.
    const base = Date.now() + 300;
    const fills: FillEvent[] = priced.map((s, i) => ({
      venueOrderId: order.venueOrderId,
      venueFillId: randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: s.qty.toString(),
      price: s.price.toFixed(6),
      fee: grossValue.gt(0)
        ? fee.times(s.price.times(s.qty)).div(grossValue).toFixed(6)
        : '0',
      // Never the decision-time price: a real fill lands after a round trip.
      filledAt: new Date(base + i * 250).toISOString(),
    }));

    queueMicrotask(() => {
      for (const f of fills) for (const l of this.listeners) l(f);
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

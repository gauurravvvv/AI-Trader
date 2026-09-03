import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { SimAdapter, US_COSTS, IN_COSTS, type PriceSource } from './sim.js';
import { runConformanceSuite } from './conformance.js';
import type { Quote } from './types.js';

function fixedPrices(last = 100, spread = 0.02, volume = 1_000_000): PriceSource {
  return {
    quote: async (symbol: string): Promise<Quote | null> => ({
      symbol,
      last: String(last),
      bid: String(last - spread / 2),
      ask: String(last + spread / 2),
      volume: String(volume),
      at: new Date().toISOString(),
    }),
  };
}

const CONSTRAINTS = {
  tickSize: '0.01',
  lotSize: '1',
  minNotional: '1',
  supportsFractional: false,
  supportsShort: false,
};
const ALWAYS_OPEN = { isOpen: (): boolean => true };

function usSim(prices = fixedPrices()): SimAdapter {
  return new SimAdapter(
    'alpaca-paper', 'US', prices, US_COSTS, '100000', CONSTRAINTS, ALWAYS_OPEN,
  );
}

runConformanceSuite('SimAdapter', async () => usSim());

describe('SimAdapter fill model', () => {
  it('never fills a buy better than the mid — the spread is always paid', async () => {
    const a = usSim();
    const o = await a.submitOrder({
      clientOrderId: 'a:0', symbol: 'X', side: 'buy', type: 'market', qty: '10',
    });
    expect(new Decimal(o.avgFillPrice!).gt(100)).toBe(true);
  });

  it('never fills a sell better than the mid', async () => {
    const a = usSim();
    const o = await a.submitOrder({
      clientOrderId: 'b:0', symbol: 'X', side: 'sell', type: 'market', qty: '10',
    });
    expect(new Decimal(o.avgFillPrice!).lt(100)).toBe(true);
  });

  it('charges a large order more per share than a small one (superlinear impact)', async () => {
    const small = await usSim().submitOrder({
      clientOrderId: 's:0', symbol: 'X', side: 'buy', type: 'market', qty: '100',
    });
    const large = await usSim().submitOrder({
      clientOrderId: 'l:0', symbol: 'X', side: 'buy', type: 'market', qty: '200000',
    });
    expect(new Decimal(large.avgFillPrice!).gt(small.avgFillPrice!)).toBe(true);
  });

  it('applies a slippage floor even in an infinitely liquid book', async () => {
    const a = usSim(fixedPrices(100, 0, 1e12));
    const o = await a.submitOrder({
      clientOrderId: 'f:0', symbol: 'X', side: 'buy', type: 'market', qty: '1',
    });
    // zero spread, negligible participation — the floor must still bite
    expect(new Decimal(o.avgFillPrice!).gt(100)).toBe(true);
  });

  it('is worse than a naive close-price fill — the simulator must not flatter us', async () => {
    const a = usSim();
    const o = await a.submitOrder({
      clientOrderId: 'n:0', symbol: 'X', side: 'buy', type: 'market', qty: '1000',
    });
    const naive = new Decimal(100).times(1000);
    const modelled = new Decimal(o.avgFillPrice!).times(1000);
    expect(modelled.gt(naive)).toBe(true);
  });

  it('charges the full Indian cost stack on an IN venue', async () => {
    const inSim = new SimAdapter(
      'india-sim', 'IN', fixedPrices(), IN_COSTS, '1000000', CONSTRAINTS, ALWAYS_OPEN,
    );
    const before = await inSim.getAccount();
    const fills: string[] = [];
    inSim.streamFills((e) => fills.push(e.fee));
    await inSim.submitOrder({
      clientOrderId: 'i:0', symbol: 'X', side: 'buy', type: 'market', qty: '100',
    });
    await new Promise((r) => setTimeout(r, 50));
    // brokerage/STT/GST/stamp on ~10,000 notional, plus the 20 flat fee
    expect(new Decimal(fills[0]!).gt(20)).toBe(true);
    expect(before.currency).toBe('INR');
  });

  it('dates the fill after the decision — never at the decision-time price', async () => {
    const a = usSim();
    const at: string[] = [];
    a.streamFills((e) => at.push(e.filledAt));
    const t0 = Date.now();
    await a.submitOrder({
      clientOrderId: 't:0', symbol: 'X', side: 'buy', type: 'market', qty: '1',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(new Date(at[0]!).getTime()).toBeGreaterThanOrEqual(t0 + 300);
  });

  it('rejects when no quote is available rather than inventing a price', async () => {
    const a = new SimAdapter(
      'alpaca-paper', 'US', { quote: async () => null }, US_COSTS, '1000',
      CONSTRAINTS, ALWAYS_OPEN,
    );
    const o = await a.submitOrder({
      clientOrderId: 'z:0', symbol: 'GONE', side: 'buy', type: 'market', qty: '1',
    });
    expect(o.status).toBe('rejected');
  });

  it('leaves an unmarketable limit order open instead of filling it', async () => {
    const a = usSim();
    const o = await a.submitOrder({
      clientOrderId: 'lim:0', symbol: 'X', side: 'buy', type: 'limit', qty: '10',
      limitPrice: '90',
    });
    expect(o.status).toBe('submitted');
    expect(o.filledQty).toBe('0');
  });

  it('deducts cash and fees on a buy', async () => {
    const a = usSim();
    await a.submitOrder({
      clientOrderId: 'c:0', symbol: 'X', side: 'buy', type: 'market', qty: '100',
    });
    const acct = await a.getAccount();
    expect(new Decimal(acct.cash).lt(100000)).toBe(true);
  });
});

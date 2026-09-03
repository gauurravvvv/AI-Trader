import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  evaluate,
  maxPermittedQty,
  DEFAULT_LIMITS,
  type RiskContext,
  type ProposedOrder,
} from './officer.js';

const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  halted: false,
  marketOpen: true,
  equity: '100000',
  cash: '100000',
  grossExposure: '0',
  marketExposure: '0',
  openPositions: 0,
  realisedPnlToday: '0',
  adv: '1000000',
  duplicateRecent: false,
  ...over,
});

// 20 shares at $100 = $2,000 = 2% of a $100k account
const buy = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: 'NVDA',
  side: 'buy',
  qty: '20',
  price: '100',
  ...over,
});

describe('Risk Officer — happy path', () => {
  it('passes a well-sized order', () => {
    const r = evaluate(buy(), ctx());
    expect(r.passed).toBe(true);
    expect(r.rejectReasons).toEqual([]);
  });

  it('records every check, passing or not', () => {
    expect(evaluate(buy(), ctx()).checks.length).toBeGreaterThanOrEqual(12);
  });
});

describe('Risk Officer — gates that stop everything', () => {
  it('blocks a buy when halted', () => {
    expect(evaluate(buy(), ctx({ halted: true })).rejectReasons).toContain('HALTED');
  });

  it('blocks a SELL when halted — the kill switch stops exits too', () => {
    const r = evaluate(buy({ side: 'sell' }), ctx({ halted: true }));
    expect(r.passed).toBe(false);
    expect(r.rejectReasons).toContain('HALTED');
  });

  it('blocks a blocklisted symbol', () => {
    const r = evaluate(buy(), ctx(), { ...DEFAULT_LIMITS, blocklist: ['NVDA'] });
    expect(r.rejectReasons).toContain('BLOCKLIST');
  });

  it('refuses a zero or missing price rather than guessing', () => {
    expect(evaluate(buy({ price: '0' }), ctx()).rejectReasons).toContain('NO_QUOTE');
  });
});

describe('Risk Officer — exits are permitted where entries are not', () => {
  it('allows a sell when the market cap is already breached', () => {
    const r = evaluate(buy({ side: 'sell' }), ctx({ marketExposure: '90000' }));
    expect(r.passed).toBe(true);
  });

  it('allows a sell after the daily loss stop has tripped', () => {
    const r = evaluate(buy({ side: 'sell' }), ctx({ realisedPnlToday: '-9999' }));
    expect(r.passed).toBe(true);
  });

  it('allows a sell at max open positions', () => {
    expect(evaluate(buy({ side: 'sell' }), ctx({ openPositions: 99 })).passed).toBe(true);
  });

  it('allows a sell when the market is closed', () => {
    expect(evaluate(buy({ side: 'sell' }), ctx({ marketOpen: false })).passed).toBe(true);
  });

  it('but still blocks a BUY in every one of those states', () => {
    for (const over of [
      { marketExposure: '90000' },
      { realisedPnlToday: '-9999' },
      { openPositions: 99 },
      { marketOpen: false },
    ]) {
      expect(evaluate(buy(), ctx(over)).passed).toBe(false);
    }
  });
});

describe('Risk Officer — sizing gates', () => {
  it('rejects an order above the per-position cap', () => {
    // 100 x 100 = 10,000 = 10% of equity, cap is 5%
    expect(evaluate(buy({ qty: '100' }), ctx()).rejectReasons).toContain('POSITION_CAP');
  });

  it('rejects when the market cap would be breached', () => {
    expect(evaluate(buy(), ctx({ marketExposure: '49500' })).rejectReasons).toContain('MARKET_CAP');
  });

  it('rejects leverage', () => {
    expect(evaluate(buy(), ctx({ grossExposure: '99500' })).rejectReasons).toContain(
      'GROSS_EXPOSURE',
    );
  });

  it('rejects after the daily loss stop', () => {
    // -2% of 100k = -2000
    expect(evaluate(buy(), ctx({ realisedPnlToday: '-2001' })).rejectReasons).toContain(
      'DAILY_LOSS_STOP',
    );
  });

  it('allows an entry just inside the daily loss stop', () => {
    expect(evaluate(buy(), ctx({ realisedPnlToday: '-1999' })).passed).toBe(true);
  });

  it('rejects at max open positions', () => {
    expect(evaluate(buy(), ctx({ openPositions: 10 })).rejectReasons).toContain('MAX_POSITIONS');
  });

  it('rejects a dust order below min notional', () => {
    expect(evaluate(buy({ qty: '1', price: '10' }), ctx()).rejectReasons).toContain('MIN_NOTIONAL');
  });

  it('rejects insufficient cash', () => {
    expect(evaluate(buy(), ctx({ cash: '100' })).rejectReasons).toContain('INSUFFICIENT_CASH');
  });

  it('rejects a duplicate within the dedupe window', () => {
    expect(evaluate(buy(), ctx({ duplicateRecent: true })).rejectReasons).toContain('DUPLICATE');
  });
});

describe('Risk Officer — liquidity', () => {
  it('rejects an order that is too large a share of ADV', () => {
    // 20,000 shares against 1M ADV = 2%, cap is 1%
    expect(evaluate(buy({ qty: '20000' }), ctx()).rejectReasons).toContain('LIQUIDITY');
  });

  it('treats UNKNOWN ADV as a failure, not a pass', () => {
    // The name we cannot measure is exactly the one that will not fill at the
    // modelled price. Fail closed.
    expect(evaluate(buy(), ctx({ adv: null })).rejectReasons).toContain('LIQUIDITY');
  });
});

describe('maxPermittedQty', () => {
  it('sizes to the per-position cap when that is the binding constraint', () => {
    // 5% of 100k at $100 = 50 shares
    expect(maxPermittedQty('100', ctx())).toBe('50');
  });

  it('sizes down to available cash', () => {
    expect(Number(maxPermittedQty('100', ctx({ cash: '1000' })))).toBe(10);
  });

  it('sizes down to the ADV cap', () => {
    // 1% of a 1,000-share ADV = 10
    expect(maxPermittedQty('100', ctx({ adv: '1000' }))).toBe('10');
  });

  it('returns 0 when ADV is unknown', () => {
    expect(maxPermittedQty('100', ctx({ adv: null }))).toBe('0');
  });

  it('returns 0 rather than a negative when caps are already breached', () => {
    expect(maxPermittedQty('100', ctx({ grossExposure: '200000' }))).toBe('0');
  });

  it('always yields a quantity that then passes evaluate()', () => {
    // Property: whatever the sizer returns must clear the gate it sized against.
    for (const c of [
      ctx(),
      ctx({ cash: '5000' }),
      ctx({ adv: '3000' }),
      ctx({ marketExposure: '40000' }),
      ctx({ grossExposure: '80000' }),
    ]) {
      const q = maxPermittedQty('100', c);
      if (new Decimal(q).lte(0)) continue;
      const r = evaluate(buy({ qty: q, price: '100' }), c);
      expect(r.rejectReasons.filter((x) => x !== 'MIN_NOTIONAL')).toEqual([]);
    }
  });
});

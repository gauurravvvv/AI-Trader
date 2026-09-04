import Decimal from 'decimal.js';

export type RejectCode =
  | 'HALTED'
  | 'POSITION_CAP'
  | 'MARKET_CAP'
  | 'GROSS_EXPOSURE'
  | 'DAILY_LOSS_STOP'
  | 'MAX_POSITIONS'
  | 'LIQUIDITY'
  | 'MIN_NOTIONAL'
  | 'BLOCKLIST'
  | 'MARKET_CLOSED'
  | 'DUPLICATE'
  | 'INSUFFICIENT_CASH'
  | 'NO_QUOTE'
  | 'PATTERN_DAY_TRADER';

export interface RiskLimits {
  maxPositionPct: number; // of equity
  maxMarketPct: number;
  maxGrossExposurePct: number;
  dailyLossStopPct: number;
  maxOpenPositions: number;
  maxAdvParticipation: number; // order qty / average daily volume
  minNotional: string;
  blocklist: readonly string[];
  /**
   * FINRA marks an account a pattern day trader at four day trades in five
   * business days, and then requires $25,000 to keep day trading. Below that
   * equity the fourth trade is refused rather than taken.
   *
   * Modelled in paper because the constraint shapes the strategy: a system
   * that learns to scalp on a simulator with no PDT rule has learned something
   * it could never do with the account it is being built for.
   */
  pdtEquityFloor: string;
  pdtMaxDayTrades: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxPositionPct: 0.05,
  maxMarketPct: 0.5,
  maxGrossExposurePct: 1.0, // no leverage
  dailyLossStopPct: 0.02,
  maxOpenPositions: 10,
  maxAdvParticipation: 0.01,
  minNotional: '100',
  blocklist: [],
  pdtEquityFloor: '25000',
  pdtMaxDayTrades: 3,
};

export interface RiskContext {
  halted: boolean;
  marketOpen: boolean;
  equity: string;
  cash: string;
  /** Sum of |notional| across all open positions, this venue. */
  grossExposure: string;
  /** Notional already held in this market. */
  marketExposure: string;
  openPositions: number;
  realisedPnlToday: string;
  /** Average daily volume for the symbol, in shares. Null when unknown. */
  adv: string | null;
  /** An identical symbol+side order submitted within the dedupe window. */
  duplicateRecent: boolean;
  /** Round trips closed within the same session, last five business days. */
  dayTradesLast5Days: number;
  /**
   * True when this order would close a position opened today — i.e. it is
   * itself a day trade. Only meaningful for sells.
   */
  wouldBeDayTrade: boolean;
  /** PDT applies to margin equity accounts, not crypto and not India. */
  pdtApplies: boolean;
}

export interface ProposedOrder {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  price: string;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskEvaluation {
  passed: boolean;
  checks: RiskCheck[];
  rejectReasons: RejectCode[];
}

/**
 * Deterministic risk gate. INV-4: pure functions, no I/O, no LLM.
 *
 * This is the only component in the system that can refuse a trade and mean it.
 * An agent that hallucinates a support level costs a mediocre entry; one that
 * hallucinates a position limit costs the account. So nothing here is a model.
 *
 * Sells are evaluated more permissively than buys on purpose: refusing to
 * *reduce* risk is not risk management. Only the halt and blocklist gates can
 * stop an exit.
 */
export function evaluate(
  order: ProposedOrder,
  ctx: RiskContext,
  limits: RiskLimits = DEFAULT_LIMITS,
): RiskEvaluation {
  const checks: RiskCheck[] = [];
  const reject: RejectCode[] = [];

  const add = (name: string, passed: boolean, detail: string, code: RejectCode): void => {
    checks.push({ name, passed, detail });
    if (!passed) reject.push(code);
  };

  const isExit = order.side === 'sell';
  const qty = new Decimal(order.qty);
  const price = new Decimal(order.price);
  const notional = qty.times(price);
  const equity = new Decimal(ctx.equity);

  // ── Gates that stop everything, exits included ──
  add('halt', !ctx.halted, ctx.halted ? 'global HALT engaged' : 'not halted', 'HALTED');
  add(
    'blocklist',
    !limits.blocklist.includes(order.symbol),
    `${order.symbol} ${limits.blocklist.includes(order.symbol) ? 'is' : 'is not'} blocklisted`,
    'BLOCKLIST',
  );
  add(
    'quote',
    price.gt(0),
    price.gt(0) ? `price ${price.toString()}` : 'no usable price',
    'NO_QUOTE',
  );
  add('qty', qty.gt(0), `qty ${qty.toString()}`, 'MIN_NOTIONAL');

  if (isExit) {
    // Reducing exposure is always permitted once the above pass — with one
    // exception, and it is a legal one rather than a risk one: closing a
    // position opened today is itself a day trade, and under the PDT rule an
    // undercapitalised account may not make a fourth one. Blocking an exit is
    // otherwise something this system never does, so it is gated tightly:
    // only on a same-day round trip, only below the equity floor, only when
    // the count is already at the limit.
    if (ctx.pdtApplies && ctx.wouldBeDayTrade) {
      const under = equity.lt(limits.pdtEquityFloor);
      const atLimit = ctx.dayTradesLast5Days >= limits.pdtMaxDayTrades;
      add(
        'pattern_day_trader',
        !(under && atLimit),
        under && atLimit
          ? `${String(ctx.dayTradesLast5Days)} day trades in 5 sessions with equity ${equity.toFixed(2)} below ${limits.pdtEquityFloor}`
          : `${String(ctx.dayTradesLast5Days)} day trades, equity ${equity.toFixed(2)}`,
        'PATTERN_DAY_TRADER',
      );
    }
    return { passed: reject.length === 0, checks, rejectReasons: [...new Set(reject)] };
  }

  // ── Entry-only gates ──
  add(
    'market_open',
    ctx.marketOpen,
    ctx.marketOpen ? 'market open' : 'market closed',
    'MARKET_CLOSED',
  );

  add(
    'min_notional',
    notional.gte(limits.minNotional),
    `notional ${notional.toFixed(2)} vs min ${limits.minNotional}`,
    'MIN_NOTIONAL',
  );

  const posPct = equity.gt(0) ? notional.div(equity) : new Decimal(1);
  add(
    'position_cap',
    posPct.lte(limits.maxPositionPct),
    `${posPct.times(100).toFixed(2)}% of equity vs cap ${String(limits.maxPositionPct * 100)}%`,
    'POSITION_CAP',
  );

  const marketPct = equity.gt(0)
    ? new Decimal(ctx.marketExposure).plus(notional).div(equity)
    : new Decimal(1);
  add(
    'market_cap',
    marketPct.lte(limits.maxMarketPct),
    `market would be ${marketPct.times(100).toFixed(2)}% vs cap ${String(limits.maxMarketPct * 100)}%`,
    'MARKET_CAP',
  );

  const grossPct = equity.gt(0)
    ? new Decimal(ctx.grossExposure).plus(notional).div(equity)
    : new Decimal(1);
  add(
    'gross_exposure',
    grossPct.lte(limits.maxGrossExposurePct),
    `gross would be ${grossPct.times(100).toFixed(2)}% vs cap ${String(limits.maxGrossExposurePct * 100)}%`,
    'GROSS_EXPOSURE',
  );

  const lossLimit = equity.times(limits.dailyLossStopPct).negated();
  const pnl = new Decimal(ctx.realisedPnlToday);
  add(
    'daily_loss_stop',
    pnl.gte(lossLimit),
    `realised today ${pnl.toFixed(2)} vs stop ${lossLimit.toFixed(2)}`,
    'DAILY_LOSS_STOP',
  );

  add(
    'max_positions',
    ctx.openPositions < limits.maxOpenPositions,
    `${String(ctx.openPositions)} open vs max ${String(limits.maxOpenPositions)}`,
    'MAX_POSITIONS',
  );

  add(
    'cash',
    new Decimal(ctx.cash).gte(notional),
    `cash ${ctx.cash} vs notional ${notional.toFixed(2)}`,
    'INSUFFICIENT_CASH',
  );

  // Unknown ADV is treated as a failure, not a pass. An illiquid name we cannot
  // measure is exactly the one that will not fill at the modelled price.
  const advOk = ctx.adv !== null && qty.div(ctx.adv).lte(limits.maxAdvParticipation);
  add(
    'liquidity',
    advOk,
    ctx.adv === null
      ? 'ADV unknown'
      : `${qty.div(ctx.adv).times(100).toFixed(3)}% of ADV vs cap ${String(limits.maxAdvParticipation * 100)}%`,
    'LIQUIDITY',
  );

  add(
    'duplicate',
    !ctx.duplicateRecent,
    ctx.duplicateRecent ? 'identical order within dedupe window' : 'no recent duplicate',
    'DUPLICATE',
  );

  return { passed: reject.length === 0, checks, rejectReasons: [...new Set(reject)] };
}

/**
 * Largest quantity that clears every sizing gate, or '0' when none does.
 * Used to resize rather than reject when the only problem is that the order is
 * too big.
 */
export function maxPermittedQty(
  price: string,
  ctx: RiskContext,
  limits: RiskLimits = DEFAULT_LIMITS,
): string {
  const p = new Decimal(price);
  if (p.lte(0)) return '0';
  const equity = new Decimal(ctx.equity);

  const byPosition = equity.times(limits.maxPositionPct).div(p);
  const byMarket = equity.times(limits.maxMarketPct).minus(ctx.marketExposure).div(p);
  const byGross = equity.times(limits.maxGrossExposurePct).minus(ctx.grossExposure).div(p);
  const byCash = new Decimal(ctx.cash).div(p);
  const byAdv =
    ctx.adv === null ? new Decimal(0) : new Decimal(ctx.adv).times(limits.maxAdvParticipation);

  const q = Decimal.min(byPosition, byMarket, byGross, byCash, byAdv);
  return q.gt(0) ? q.floor().toString() : '0';
}

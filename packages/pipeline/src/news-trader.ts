import Decimal from 'decimal.js';
import { BaseAgent } from '@aegis/agents';
import type { MarketId } from '@aegis/config';
import type { Ledger } from '@aegis/ledger';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { OrderRouter } from '@aegis/risk';
import type { PipelineDeps } from './agents.js';
import type { UniverseEntry } from './universe.js';
import { SIG_NEWS } from './news.js';
import { newsConditions } from './watch.js';

/** Where a market's orders go. One per market the system can actually trade. */
export interface Venue {
  market: MarketId;
  router: OrderRouter;
  ledger: Ledger;
}

export interface NewsTraderDeps extends PipelineDeps {
  prices: YahooPriceSource;
  /** Markets with a venue wired. A signal for any other market is logged and dropped. */
  venues: Venue[];
  /** Used to resolve a symbol to its market. */
  universe: UniverseEntry[];
}

export interface NewsTradeRule {
  /** newsScore below which a signal is not worth a position. */
  entryScore: number;
  /** A signal we could not categorise needs a higher bar. */
  otherCategoryScore: number;
  /** Move already made in the signal's direction that means the edge is gone. */
  alreadyPricedPct: number;
  /** Move against the signal that means the market disagrees with the read. */
  contradictionPct: number;
  /** Fraction of equity to risk per news entry. */
  sizePct: number;
}

export const DEFAULT_NEWS_RULE: NewsTradeRule = {
  entryScore: 0.6,
  otherCategoryScore: 0.75,
  // Yahoo publishes after the tape has seen the story. A name already up 6% on
  // the day has paid out the surprise; buying it is paying for someone else's
  // edge and inheriting the reversal.
  alreadyPricedPct: 0.06,
  // If the tape is moving hard against a headline the triage called bullish,
  // the tape knows something the headline does not.
  contradictionPct: 0.03,
  sizePct: 0.02,
};

/** Categories that describe an opinion rather than an event. */
const UNTRADEABLE = new Set(['OPINION', 'ANALYST', 'NOISE']);

export type NewsRejectReason =
  | 'NO_DIRECTION'
  | 'BELOW_SCORE'
  | 'UNTRADEABLE_CATEGORY'
  | 'ALREADY_PRICED'
  | 'CONTRADICTED'
  | 'NO_QUOTE'
  | 'ALREADY_HELD';

export interface NewsGateResult {
  trade: boolean;
  side: 'buy' | 'sell';
  reason: NewsRejectReason | null;
  detail: string;
}

/**
 * Deterministic gate between a triaged headline and an order.
 *
 * No model runs here, on purpose. The intelligence was spent in triage; a second
 * call per signal would double the cost of the cheapest agent in the system to
 * re-litigate a judgement it already made. This follows the same gradient as the
 * rest of the pipeline: the closer a decision gets to the money, the more of it
 * is arithmetic.
 */
export function gateNewsTrade(
  input: { score: number; direction: number; category: string; movePct: number; held: boolean },
  rule: NewsTradeRule = DEFAULT_NEWS_RULE,
): NewsGateResult {
  const side: 'buy' | 'sell' = input.direction >= 0 ? 'buy' : 'sell';
  const no = (reason: NewsRejectReason, detail: string): NewsGateResult => ({
    trade: false, side, reason, detail,
  });

  if (input.direction === 0) return no('NO_DIRECTION', 'sign unclear');
  if (input.held) return no('ALREADY_HELD', 'position already open in this name');
  if (UNTRADEABLE.has(input.category)) {
    return no('UNTRADEABLE_CATEGORY', `${input.category} is commentary, not an event`);
  }

  const floor = input.category === 'OTHER' ? rule.otherCategoryScore : rule.entryScore;
  if (input.score < floor) {
    return no('BELOW_SCORE', `score ${input.score.toFixed(2)} below ${floor.toFixed(2)}`);
  }

  const withSignal = input.movePct * Math.sign(input.direction);
  if (withSignal >= rule.alreadyPricedPct) {
    return no(
      'ALREADY_PRICED',
      `already ${(withSignal * 100).toFixed(2)}% in the signal's direction`,
    );
  }
  if (withSignal <= -rule.contradictionPct) {
    return no(
      'CONTRADICTED',
      `tape is ${(withSignal * 100).toFixed(2)}% against the read`,
    );
  }

  return {
    trade: true,
    side,
    reason: null,
    detail: `score ${input.score.toFixed(2)}, ${(input.movePct * 100).toFixed(2)}% on the day`,
  };
}

interface NewsPayload {
  title: string;
  category: string;
  direction: number;
  materiality: number;
  why: string;
  link: string;
}

/**
 * Turns a triaged headline into a position, or explains why it did not.
 *
 * Only long entries are placed: the simulator's venue constraints declare no
 * short support, so a bearish signal is recorded and used to avoid buying
 * rather than to sell short.
 */
export class NewsTraderAgent extends BaseAgent {
  private readonly marketOf: Map<string, MarketId>;
  private readonly venueOf: Map<MarketId, Venue>;

  constructor(
    private readonly p: NewsTraderDeps,
    private readonly rule: NewsTradeRule = DEFAULT_NEWS_RULE,
  ) {
    super('news-trader', { intervalMs: 2 * 60 * 1000 }, p);
    this.marketOf = new Map(p.universe.map((e) => [e.symbol, e.market]));
    this.venueOf = new Map(p.venues.map((v) => [v.market, v]));
  }

  override shouldRun(): boolean {
    return this.bus.read([SIG_NEWS], 1).length > 0;
  }

  async execute(): Promise<void> {
    for (const sig of this.bus.read([SIG_NEWS], 5)) {
      const symbol = sig.symbol ?? '?';
      const d = sig.data as unknown as NewsPayload;
      this.bus.consume([sig.id], this.name);

      const market = this.marketOf.get(symbol);
      const venue = market === undefined ? undefined : this.venueOf.get(market);
      if (!venue) {
        // A signal for a market with no venue is not an error — the scout
        // deliberately watches more than the system can trade.
        this.log.event(this.name, `${symbol}: ${market ?? 'unknown market'} has no venue wired`);
        continue;
      }

      const quote = await this.p.prices.quote(symbol);
      if (!quote) {
        this.log.warn(this.name, `${symbol}: no quote, cannot evaluate`);
        continue;
      }

      const movePct = await this.moveOnDay(symbol, quote.last);
      const score = (sig.confidence ?? 0) / 100;
      const held = venue.ledger.get(venue.router.venue, symbol) !== null;
      const g = gateNewsTrade({ score, direction: d.direction, category: d.category, movePct, held }, this.rule);

      if (!g.trade) {
        this.log.event(this.name, `${symbol}  no trade — ${g.reason ?? ''}: ${g.detail}`);
        continue;
      }
      if (g.side === 'sell') {
        // Recorded, not acted on: the venue does not support shorting.
        this.log.event(this.name, `${symbol}  bearish (${g.detail}) — no short available, standing aside`);
        continue;
      }

      this.log.ok(this.name, `${symbol}  ${d.category} ${g.detail} — proposing on ${venue.router.venue}`);
      await this.propose(venue, symbol, quote.last, d, sig.id, score);
    }
  }

  /** Move from the previous session's close to the current price. */
  private async moveOnDay(symbol: string, last: string): Promise<number> {
    const bars = await this.p.prices.bars(symbol, 5);
    const prev = bars.at(-2)?.c ?? bars.at(-1)?.c;
    if (prev === undefined || prev <= 0) return 0;
    return (Number(last) - prev) / prev;
  }

  private async propose(
    venue: Venue,
    symbol: string,
    price: string,
    d: NewsPayload,
    sourceSignalId: number,
    score: number,
  ): Promise<void> {
    const ins = this.db
      .prepare(
        `INSERT INTO decisions (symbol, market, venue, side, audit_score, audit_tier,
                                rationale, thesis_break, source_signal_id, status)
         VALUES (?,?,?, 'buy', ?,?,?,?,?, 'APPROVED')`,
      )
      .run(
        symbol,
        venue.market,
        venue.router.venue,
        Math.round(score * 100),
        d.category,
        `news: ${d.why} — ${d.title}`.slice(0, 500),
        JSON.stringify(newsConditions(price, d.direction)),
        sourceSignalId,
      );
    const decisionId = Number(ins.lastInsertRowid);

    if (this.p.autonomy === 'SHADOW') {
      this.log.warn(
        'order-router',
        `${symbol}: SHADOW mode — decision ${String(decisionId)} logged, no order placed`,
      );
      return;
    }

    const equity = new Decimal((await venue.router.buildContext()).equity);
    const qty = equity.times(this.rule.sizePct).div(price).floor();
    if (qty.lte(0)) {
      this.log.warn('order-router', `${symbol}: sized to zero`);
      return;
    }

    const bars = await this.p.prices.bars(symbol, 30);
    const adv =
      bars.length >= 5
        ? String(Math.round(bars.reduce((a, b) => a + b.v, 0) / bars.length))
        : null;

    const res = await venue.router.route(
      { decisionId, symbol, side: 'buy', qty: qty.toString(), price, allowResize: true },
      adv,
    );
    if (res.ok) {
      this.log.ok('order-router', `${symbol} BUY ${res.qty} on news → order ${String(res.orderId)}`);
    } else {
      this.log.warn('order-router', `${symbol} rejected: ${res.reason}`);
    }
  }
}

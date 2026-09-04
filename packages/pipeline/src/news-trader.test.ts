import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import { SimAdapter, US_COSTS, US_CALENDAR, type PriceSource, type Quote } from '@aegis/brokers';
import { Ledger } from '@aegis/ledger';
import { OrderRouter } from '@aegis/risk';
import type { YahooPriceSource } from '@aegis/marketdata';
import { NewsTraderAgent, gateNewsTrade, DEFAULT_NEWS_RULE, type NewsTraderDeps } from './news-trader.js';
import { SIG_NEWS } from './news.js';
import type { UniverseEntry } from './universe.js';

// ── The gate, in isolation ──────────────────────────────────────────────────

const base = { score: 0.8, direction: 0.9, category: 'PRODUCT', movePct: 0.01, held: false };

describe('gateNewsTrade', () => {
  it('passes a strong, directional, not-yet-moved signal', () => {
    const g = gateNewsTrade(base);
    expect(g.trade).toBe(true);
    expect(g.side).toBe('buy');
  });

  it('refuses a signal with no direction — certainty about nothing is nothing', () => {
    expect(gateNewsTrade({ ...base, direction: 0 }).reason).toBe('NO_DIRECTION');
  });

  it('refuses commentary categories however confident the model was', () => {
    for (const category of ['OPINION', 'ANALYST', 'NOISE']) {
      expect(gateNewsTrade({ ...base, category, score: 0.99 }).reason).toBe('UNTRADEABLE_CATEGORY');
    }
  });

  it('holds an uncategorised signal to a higher bar', () => {
    expect(gateNewsTrade({ ...base, category: 'OTHER', score: 0.65 }).reason).toBe('BELOW_SCORE');
    expect(gateNewsTrade({ ...base, category: 'OTHER', score: 0.8 }).trade).toBe(true);
  });

  it('refuses a name that has already made the move', () => {
    // Yahoo publishes after the tape has seen the story.
    const g = gateNewsTrade({ ...base, movePct: 0.08 });
    expect(g.reason).toBe('ALREADY_PRICED');
    expect(g.detail).toContain('8.00%');
  });

  it('applies already-priced in the signal direction, not in absolute terms', () => {
    // -8% on a bearish read is the move having happened, not a contradiction.
    expect(gateNewsTrade({ ...base, direction: -0.9, movePct: -0.08 }).reason).toBe('ALREADY_PRICED');
  });

  it('refuses when the tape is moving against the read', () => {
    expect(gateNewsTrade({ ...base, movePct: -0.05 }).reason).toBe('CONTRADICTED');
  });

  it('refuses to add to a name it already holds', () => {
    expect(gateNewsTrade({ ...base, held: true }).reason).toBe('ALREADY_HELD');
  });

  it('reports a bearish signal as a sell side rather than swallowing it', () => {
    const g = gateNewsTrade({ ...base, direction: -0.9, movePct: 0.01 });
    expect(g.trade).toBe(true);
    expect(g.side).toBe('sell');
  });

  it('treats the thresholds as inclusive boundaries', () => {
    expect(gateNewsTrade({ ...base, score: DEFAULT_NEWS_RULE.entryScore }).trade).toBe(true);
    expect(gateNewsTrade({ ...base, movePct: DEFAULT_NEWS_RULE.alreadyPricedPct }).reason)
      .toBe('ALREADY_PRICED');
  });
});

// ── The agent ───────────────────────────────────────────────────────────────

let db: Db;
let bus: SignalBus;
let ledger: Ledger;
let router: OrderRouter;
let last = '100';
let prevClose = 99;
const lines: string[] = [];

const src: PriceSource = {
  quote: (symbol: string): Promise<Quote> =>
    Promise.resolve({
      symbol, last, bid: String(Number(last) - 0.01), ask: String(Number(last) + 0.01),
      volume: '50000000', at: new Date().toISOString(),
    }),
};

const prices = {
  quote: (s: string) => src.quote(s),
  bars: (_s: string, n: number) =>
    Promise.resolve(
      n <= 5
        ? [{ t: '', o: 1, h: 1, l: 1, c: prevClose, v: 5e7 }, { t: '', o: 1, h: 1, l: 1, c: Number(last), v: 5e7 }]
        : Array.from({ length: 30 }, () => ({ t: '', o: 1, h: 1, l: 1, c: prevClose, v: 5e7 })),
    ),
} as unknown as YahooPriceSource;

function emit(over: Record<string, unknown> = {}, confidence = 80): void {
  bus.emit({
    agent: 'news-scout', signalType: SIG_NEWS, symbol: 'NVDA', confidence,
    data: {
      title: 'Nvidia wins $14bn contract', category: 'MA', direction: 0.9,
      materiality: 85, why: 'large contract', link: 'https://x', ...over,
    },
  });
}

const UNIVERSE: UniverseEntry[] = [
  { symbol: 'NVDA', cik: '1045810', market: 'US', name: 'NVIDIA' },
  { symbol: 'BTC', cik: null, market: 'CRYPTO', name: 'Bitcoin' },
  { symbol: 'RELIANCE', cik: null, market: 'IN', name: 'Reliance Industries' },
];

function deps(over: Partial<NewsTraderDeps> = {}): NewsTraderDeps {
  return {
    db, bus,
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    prices, router,
    venues: [{ market: 'US', router, ledger }],
    edgar: {} as never, consensus: {} as never,
    universe: UNIVERSE, sueThreshold: 1.5, auditFloor: 70,
    autonomy: 'AUTO',
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  bus = new SignalBus(db);
  ledger = new Ledger(db);
  const adapter = new SimAdapter('sim-us', 'US', src, US_COSTS, '100000', {
    tickSize: '0.01', lotSize: '1', minNotional: '1',
    supportsFractional: false, supportsShort: false,
  }, { isOpen: () => true });
  router = new OrderRouter({ db, adapter, ledger });
  router.start();
  last = '100';
  prevClose = 99;
  lines.length = 0;
});

const decisions = (): { status: string; source_signal_id: number | null; rationale: string }[] =>
  db.prepare('SELECT * FROM decisions').all() as never;

describe('NewsTraderAgent', () => {
  it('does not run with an empty queue', () => {
    expect(new NewsTraderAgent(deps()).shouldRun()).toBe(false);
  });

  it('turns a strong signal into a placed order', async () => {
    emit();
    await new NewsTraderAgent(deps()).execute();
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]!.status).toBe('EXECUTED');
    expect(db.prepare(`SELECT COUNT(*) c FROM orders WHERE side='buy'`).get()).toEqual({ c: 1 });
  });

  it('keeps the lineage back to the news signal', async () => {
    emit();
    await new NewsTraderAgent(deps()).execute();
    const d = decisions()[0]!;
    expect(d.source_signal_id).not.toBeNull();
    const sig = db.prepare('SELECT signal_type FROM agent_signals WHERE id = ?')
      .get(d.source_signal_id) as { signal_type: string };
    expect(sig.signal_type).toBe(SIG_NEWS);
  });

  it('records the headline in the rationale so a fill can be explained later', async () => {
    emit();
    await new NewsTraderAgent(deps()).execute();
    expect(decisions()[0]!.rationale).toContain('Nvidia wins $14bn contract');
  });

  it('consumes the signal so it is not traded twice', async () => {
    emit();
    const a = new NewsTraderAgent(deps());
    await a.execute();
    await a.execute();
    expect(decisions()).toHaveLength(1);
  });

  it('stands aside when the move has already happened', async () => {
    last = '108';                      // +9% on the day
    emit();
    await new NewsTraderAgent(deps()).execute();
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('ALREADY_PRICED');
  });

  it('stands aside on a bearish signal — the venue cannot short', async () => {
    emit({ direction: -0.9 });
    await new NewsTraderAgent(deps()).execute();
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('no short available');
  });

  it('places nothing in SHADOW mode but still records the decision', async () => {
    emit();
    await new NewsTraderAgent(deps({ autonomy: 'SHADOW' })).execute();
    expect(decisions()).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM orders').get()).toEqual({ c: 0 });
  });

  it('holds when the quote is missing rather than sizing off a stale price', async () => {
    emit();
    const d = deps({
      prices: { quote: () => Promise.resolve(null), bars: () => Promise.resolve([]) } as unknown as YahooPriceSource,
    });
    await new NewsTraderAgent(d).execute();
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('no quote');
  });

  it('spends no model credit at all — the intelligence was paid for in triage', async () => {
    emit();
    const ask = vi.fn();
    const d = deps({ ask: ask as never });
    await new NewsTraderAgent(d).execute();
    expect(ask).not.toHaveBeenCalled();
    expect(d.budget.spent()).toBe('0');
  });

  it('still runs at RULES_ONLY, because it never needed the model', async () => {
    emit();
    const d = deps();
    d.budget.record({ agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1, costUsd: '99', latencyMs: 1, ok: true });
    expect(d.budget.tier()).toBe('RULES_ONLY');
    await new NewsTraderAgent(d).execute();
    expect(decisions()).toHaveLength(1);
  });
});

describe('multi-venue routing', () => {
  it('drops a signal for a market with no venue wired, without erroring', async () => {
    bus.emit({
      agent: 'news-scout', signalType: SIG_NEWS, symbol: 'RELIANCE', confidence: 85,
      data: { title: 'x', category: 'MA', direction: 0.9, materiality: 90, why: 'y', link: '' },
    });
    await new NewsTraderAgent(deps()).execute();
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('IN has no venue wired');
  });

  it('routes a crypto signal to the crypto venue and stamps the market', async () => {
    const cryptoLedger = new Ledger(db);
    const cryptoAdapter = new SimAdapter('sim-crypto', 'CRYPTO', src, US_COSTS, '100000', {
      tickSize: '0.01', lotSize: '0.0001', minNotional: '1',
      supportsFractional: true, supportsShort: false,
    }, { isOpen: () => true });
    const cryptoRouter = new OrderRouter({ db, adapter: cryptoAdapter, ledger: cryptoLedger });
    cryptoRouter.start();

    bus.emit({
      agent: 'news-scout', signalType: SIG_NEWS, symbol: 'BTC', confidence: 85,
      data: { title: 'ETF approved', category: 'REGULATORY', direction: 0.9, materiality: 90, why: 'z', link: '' },
    });
    await new NewsTraderAgent(deps({
      venues: [{ market: 'US', router, ledger }, { market: 'CRYPTO', router: cryptoRouter, ledger: cryptoLedger }],
    })).execute();

    const d = db.prepare('SELECT market, venue FROM decisions').get() as { market: string; venue: string };
    expect(d.market).toBe('CRYPTO');
    expect(d.venue).toBe('sim-crypto');
  });

  it('does not confuse a holding on one venue with a holding on another', async () => {
    const cryptoLedger = new Ledger(db);
    const cryptoAdapter = new SimAdapter('sim-crypto', 'CRYPTO', src, US_COSTS, '100000', {
      tickSize: '0.01', lotSize: '1', minNotional: '1',
      supportsFractional: false, supportsShort: false,
    }, { isOpen: () => true });
    const cryptoRouter = new OrderRouter({ db, adapter: cryptoAdapter, ledger: cryptoLedger });
    cryptoRouter.start();

    // Hold NVDA on the US venue, then send a BTC signal.
    emit();
    await new NewsTraderAgent(deps()).execute();
    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      agent: 'news-scout', signalType: SIG_NEWS, symbol: 'BTC', confidence: 85,
      data: { title: 'ETF approved', category: 'REGULATORY', direction: 0.9, materiality: 90, why: 'z', link: '' },
    });
    await new NewsTraderAgent(deps({
      venues: [{ market: 'US', router, ledger }, { market: 'CRYPTO', router: cryptoRouter, ledger: cryptoLedger }],
    })).execute();
    expect(decisions()).toHaveLength(2);
  });
});

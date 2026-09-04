import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import { SimAdapter, US_COSTS, type PriceSource, type Quote } from '@aegis/brokers';
import { Ledger } from '@aegis/ledger';
import { OrderRouter } from '@aegis/risk';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import type { YahooPriceSource } from '@aegis/marketdata';
import { SentinelAgent, screen, SIG_THESIS, type SentinelDeps } from './sentinel.js';
import { SIG_NEWS } from './news.js';
import { SIG_REGIME } from './regime.js';

// ── The screen ──────────────────────────────────────────────────────────────

const sig = (id: number, symbol: string, confidence: number, direction: number, title = 't') => ({
  id, symbol, confidence,
  data: { direction, title, publisher: 'Reuters', publishedAt: '2026-09-04T10:00:00Z' },
});

describe('screen', () => {
  it('ranks by the strength of the lean, either direction', () => {
    const out = screen([sig(1, 'A', 50, 0.4), sig(2, 'B', 90, -0.9)], new Set());
    expect(out[0]!.symbol).toBe('B');
  });

  it('accumulates several stories about one name', () => {
    const out = screen([sig(1, 'A', 60, -0.6), sig(2, 'A', 70, -0.7)], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]!.headlines).toHaveLength(2);
    expect(out[0]!.lean).toBeLessThan(-0.7);
  });

  it('lets opposing stories about one name cancel', () => {
    const out = screen([sig(1, 'A', 80, 0.8), sig(2, 'A', 80, -0.8)], new Set());
    expect(Math.abs(out[0]!.lean)).toBeLessThan(0.1);
  });

  it('drops names already held — analysing them costs money for a foregone answer', () => {
    expect(screen([sig(1, 'A', 90, 0.9)], new Set(['A']))).toHaveLength(0);
  });

  it('drops weak signals before they reach the expensive part', () => {
    expect(screen([sig(1, 'A', 10, 0.9)], new Set(), 0.35)).toHaveLength(0);
  });

  it('ignores a signal with no headline', () => {
    const bad = { id: 1, symbol: 'A', confidence: 90, data: { direction: 0.9, title: '' } };
    expect(screen([bad], new Set())).toHaveLength(0);
  });

  it('ignores a signal with no symbol', () => {
    const bad = { id: 1, symbol: null, confidence: 90, data: { direction: 0.9, title: 'x' } };
    expect(screen([bad], new Set())).toHaveLength(0);
  });
});

// ── The agent ───────────────────────────────────────────────────────────────

let db: Db;
let bus: SignalBus;
let ledger: Ledger;
let router: OrderRouter;
let last = '100';
const lines: string[] = [];
const notes: { kind: string; subject: string; body: string }[] = [];
const VENUE = 'sim-us';

const src: PriceSource = {
  quote: (symbol: string): Promise<Quote> =>
    Promise.resolve({
      symbol, last, bid: String(Number(last) - 0.01), ask: String(Number(last) + 0.01),
      volume: '80000000', at: new Date().toISOString(),
    }),
};

const prices = {
  quote: (s: string) => src.quote(s),
  bars: () => Promise.resolve(Array.from({ length: 30 }, () => ({ t: '', o: 100, h: 100, l: 100, c: 100, v: 8e7 }))),
} as unknown as YahooPriceSource;

const THESIS_LONG = JSON.stringify({
  direction: 'LONG', conviction: 85,
  thesis: 'A large contract win adds revenue that is not in current estimates.',
  claims: ['Nvidia won a contract worth $14bn'],
  invalidators: ['The contract is denied'], horizonDays: 10,
});
const THESIS_SHORT = JSON.stringify({
  direction: 'SHORT', conviction: 85,
  thesis: 'A settlement of this size is a direct and unbudgeted cash cost.',
  claims: ['Meta faces a $17bn settlement'],
  invalidators: ['The settlement is overturned'], horizonDays: 10,
});
const THESIS_NONE = JSON.stringify({
  direction: 'NONE', conviction: 10,
  thesis: 'The headlines are commentary and support no directional view at all.',
  claims: ['Nothing material is stated'], invalidators: ['A material fact emerges'], horizonDays: 5,
});
const PASS = JSON.stringify({
  claimVerdicts: [{ claim: 'x', verdict: 'SUPPORTED', why: 'stated' }],
  bearCase: 'The move may already be priced after a run of this size.',
  verdict: 'PROCEED', confidence: 80, oneLine: 'Facts hold.',
});
const REJECT = JSON.stringify({
  claimVerdicts: [{ claim: 'x', verdict: 'CONTRADICTED', why: 'the headline says the opposite' }],
  bearCase: 'The premise is simply wrong.',
  verdict: 'REJECT', confidence: 90, oneLine: 'The premise is contradicted.',
});

/** Replies in order: analyst first, then challenger. */
function scripted(...texts: string[]): { ask: AskFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const ask: AskFn = (prompt, opts) => {
    calls.push(opts.agent);
    const text = texts[Math.min(i, texts.length - 1)] ?? '{}';
    i += 1;
    return Promise.resolve({
      model: 'sonnet', text, tokensIn: 28000, tokensOut: 400,
      costUsd: '0.02', latencyMs: 15000, promptHash: 'h',
      cacheReadTokens: 27414, cacheCreateTokens: 0, costMeasured: true,
    } satisfies ClaudeResult);
  };
  return { ask, calls };
}

function emitNews(symbol: string, confidence: number, direction: number, title: string): void {
  bus.emit({
    agent: 'news-scout', signalType: SIG_NEWS, symbol, confidence,
    data: { direction, title, publisher: 'Reuters', publishedAt: '2026-09-04T10:00:00Z',
            category: 'MA', materiality: 80, why: 'x', link: '' },
  });
}

function deps(over: Partial<SentinelDeps> = {}): SentinelDeps {
  return {
    db, bus,
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    prices, ledger, router,
    edgar: {} as never, consensus: {} as never,
    universe: [], sueThreshold: 1.5, auditFloor: 70,
    autonomy: 'AUTO',
    notify: (n) => notes.push(n),
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  bus = new SignalBus(db);
  ledger = new Ledger(db);
  const adapter = new SimAdapter(VENUE, 'US', src, US_COSTS, '100000', {
    tickSize: '0.01', lotSize: '1', minNotional: '1',
    supportsFractional: false, supportsShort: true,
  }, { isOpen: () => true });
  router = new OrderRouter({ db, adapter, ledger });
  router.start();
  last = '100';
  lines.length = 0;
  notes.length = 0;
});

const decisions = (): { side: string; status: string; rationale: string }[] =>
  db.prepare('SELECT * FROM decisions').all() as never;

describe('SentinelAgent', () => {
  it('does not run with no news', () => {
    expect(new SentinelAgent(deps()).shouldRun()).toBe(false);
  });

  it('runs the full flow and goes long', async () => {
    emitNews('NVDA', 80, 0.9, 'Nvidia wins $14bn AI contract');
    const s = scripted(THESIS_LONG, PASS);
    await new SentinelAgent(deps({ ask: s.ask })).execute();
    expect(s.calls).toEqual(['analyst', 'challenger']);
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]!.side).toBe('buy');
    expect(d[0]!.status).toBe('EXECUTED');
  });

  it('goes SHORT on a bearish thesis — the whole point of this rebuild', async () => {
    emitNews('META', 80, -0.9, 'Meta faces $17bn teen safety settlement');
    await new SentinelAgent(deps({ ask: scripted(THESIS_SHORT, PASS).ask })).execute();
    const d = decisions();
    expect(d[0]!.side).toBe('sell');
    expect(d[0]!.rationale).toContain('SHORT');
    // And the position is genuinely short.
    await new Promise((r) => setTimeout(r, 60));
    expect(Number(ledger.get(VENUE, 'META')!.qty)).toBeLessThan(0);
  });

  it('does not challenge a thesis the analyst declined — that call is wasted', async () => {
    emitNews('NVDA', 80, 0.9, 'Some commentary');
    const s = scripted(THESIS_NONE, PASS);
    await new SentinelAgent(deps({ ask: s.ask })).execute();
    expect(s.calls).toEqual(['analyst']);
    expect(decisions()).toHaveLength(0);
  });

  it('does not trade when the challenger contradicts a claim', async () => {
    emitNews('NVDA', 80, 0.9, 'Nvidia wins contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, REJECT).ask })).execute();
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('contradicted');
  });

  it('fails closed when the challenger reply is unparseable', async () => {
    // A debate we could not finish is not a debate that was won.
    emitNews('NVDA', 80, 0.9, 'Nvidia wins contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, 'I think it is fine').ask })).execute();
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('no trade');
  });

  it('records the debate on the bus whether or not it traded', async () => {
    emitNews('NVDA', 80, 0.9, 'Nvidia wins contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, REJECT).ask })).execute();
    const t = bus.latest([SIG_THESIS], 5);
    expect(t).toHaveLength(1);
    expect((t[0]!.data as { traded: boolean }).traded).toBe(false);
  });

  it('sizes down in a risk-off market when going long', async () => {
    bus.emit({ agent: 'market-regime', signalType: SIG_REGIME, data: { regime: 'RISK_OFF' } });
    emitNews('NVDA', 80, 0.9, 'Nvidia wins contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, PASS).ask })).execute();
    await new Promise((r) => setTimeout(r, 60));
    const riskOff = Number(ledger.get(VENUE, 'NVDA')!.qty);

    // Same setup, risk-on.
    db = openDb(':memory:'); bus = new SignalBus(db); ledger = new Ledger(db);
    const a2 = new SimAdapter(VENUE, 'US', src, US_COSTS, '100000', {
      tickSize: '0.01', lotSize: '1', minNotional: '1', supportsFractional: false, supportsShort: true,
    }, { isOpen: () => true });
    router = new OrderRouter({ db, adapter: a2, ledger }); router.start();
    bus.emit({ agent: 'market-regime', signalType: SIG_REGIME, data: { regime: 'RISK_ON' } });
    emitNews('NVDA', 80, 0.9, 'Nvidia wins contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, PASS).ask })).execute();
    await new Promise((r) => setTimeout(r, 60));
    expect(Number(ledger.get(VENUE, 'NVDA')!.qty)).toBeGreaterThan(riskOff);
  });

  it('emails the thesis AND the case against it', async () => {
    emitNews('NVDA', 80, 0.9, 'Nvidia wins $14bn AI contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, PASS).ask })).execute();
    const n = notes.find((x) => x.kind === 'ORDER_SUBMITTED')!;
    expect(n.body).toContain('Thesis:');
    expect(n.body).toContain('The case against:');
    expect(n.body).toContain('This is wrong if:');
    expect(n.body).toContain('Nvidia wins $14bn AI contract');
  });

  it('places nothing in SHADOW but still records the decision', async () => {
    emitNews('NVDA', 80, 0.9, 'Nvidia wins contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, PASS).ask, autonomy: 'SHADOW' })).execute();
    expect(decisions()).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) c FROM orders').get()).toEqual({ c: 0 });
  });

  it('analyses one candidate per tick, deferring the rest', async () => {
    emitNews('NVDA', 80, 0.9, 'a');
    emitNews('AMD', 80, -0.9, 'b');
    const s = scripted(THESIS_LONG, PASS);
    await new SentinelAgent(deps({ ask: s.ask })).execute();
    expect(s.calls.filter((c) => c === 'analyst')).toHaveLength(1);
    expect(lines.join('\n')).toContain('deferred');
  });

  it('stops once the daily analysis cap is reached', async () => {
    for (let i = 0; i < 3; i += 1) {
      db.prepare(
        `INSERT INTO llm_calls (agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok)
         VALUES ('analyst','sonnet',1,1,'0.02',1,1)`,
      ).run();
    }
    emitNews('NVDA', 80, 0.9, 'a');
    expect(new SentinelAgent(deps({ maxAnalysesPerDay: 3 })).shouldRun()).toBe(false);
  });

  it('consumes the signals it looked at, so they are not re-screened forever', async () => {
    emitNews('NVDA', 80, 0.9, 'a');
    emitNews('AMD', 80, -0.9, 'b');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, PASS).ask })).execute();
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(0);
  });

  it('records the headlines it acted on as provenance', async () => {
    emitNews('NVDA', 80, 0.9, 'Nvidia wins $14bn AI contract');
    await new SentinelAgent(deps({ ask: scripted(THESIS_LONG, PASS).ask })).execute();
    const rows = db.prepare(`SELECT kind, reference FROM provenance`).all() as
      { kind: string; reference: string }[];
    expect(rows.some((r) => r.kind === 'news' && r.reference.includes('14bn'))).toBe(true);
  });

  it('holds when there is no quote rather than sizing off a stale price', async () => {
    emitNews('NVDA', 80, 0.9, 'a');
    const d = deps({
      ask: scripted(THESIS_LONG, PASS).ask,
      prices: { quote: () => Promise.resolve(null), bars: () => Promise.resolve([]) } as unknown as YahooPriceSource,
    });
    await new SentinelAgent(d).execute();
    expect(decisions()).toHaveLength(0);
  });
});

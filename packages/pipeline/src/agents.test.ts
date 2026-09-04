import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import { SimAdapter, US_COSTS, type PriceSource, type Quote } from '@aegis/brokers';
import { Ledger } from '@aegis/ledger';
import { OrderRouter } from '@aegis/risk';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import type { EdgarClient } from '@aegis/edgar';
import type { YahooConsensus, YahooPriceSource } from '@aegis/marketdata';
import { EdgarPollerAgent, EarningsReaderAgent, type PipelineDeps } from './agents.js';
import type { UniverseEntry } from './universe.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const UNIVERSE: UniverseEntry[] = [
  { symbol: 'NVDA', cik: '1045810', market: 'US', name: 'NVIDIA' },
  { symbol: 'BTC', cik: null, market: 'CRYPTO', name: 'Bitcoin' },
];

const FILING_TEXT =
  'NVIDIA today reported record revenue. We are raising our full-year outlook. ' +
  'Data center demand continues to accelerate beyond our prior expectations.';

/** A read the scorer will like: raised guidance, strong momentum, no hedging. */
const STRONG_READ = {
  guidanceDelta: 'RAISED',
  guidanceEvidence: 'We are raising our full-year outlook.',
  languageTone: 0.8,
  hedgingDensity: 0.05,
  momentumShift: 0.9,
  riskFlags: [],
  keyQuotes: [{ quote: 'We are raising our full-year outlook.', why: 'explicit raise' }],
  oneLineWhy: 'Guidance raised on accelerating data-centre demand.',
  confidence: 90,
  dataGaps: [],
};

const WEAK_READ = { ...STRONG_READ, guidanceDelta: 'LOWERED', languageTone: -0.6, momentumShift: -0.7 };

/** Five dimensions of 20, so `total` is the score the Auditor will compute. */
function audit(total: number, verdict = 'PROCEED'): Record<string, unknown> {
  const each = Math.round(total / 5);
  return {
    dataQuality: each,
    methodology: each,
    signalConsistency: each,
    riskCoverage: each,
    reasoningTransparency: each,
    redFlags: [],
    verdict,
    oneLineJudgement: 'Reasonable.',
  };
}

/** Returns the read first, then the audit — the order the pipeline calls them in. */
function scriptedAsk(reads: unknown[]): { ask: AskFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const ask: AskFn = (prompt) => {
    calls.push(prompt.slice(0, 40));
    const payload = reads[Math.min(i, reads.length - 1)];
    i += 1;
    return Promise.resolve({
      model: 'haiku',
      text: JSON.stringify(payload),
      tokensIn: 100,
      tokensOut: 50,
      costUsd: '0.0001',
      latencyMs: 10,
      promptHash: 'test',
    } satisfies ClaudeResult);
  };
  return { ask, calls };
}

const prices: PriceSource = {
  quote: (symbol: string): Promise<Quote> =>
    Promise.resolve({
      symbol, last: '100', bid: '99.99', ask: '100.01',
      volume: '50000000', at: new Date().toISOString(),
    }),
};

function fakeEdgar(filings: { accessionNo: string; filedAt: string }[], exhibit: string | null) {
  return {
    recentEarnings8K: vi.fn(() =>
      Promise.resolve(filings.map((f) => ({ ...f, cik: '1045810', form: '8-K', items: ['2.02'] }))),
    ),
    earningsExhibit: vi.fn(() => Promise.resolve(exhibit)),
  } as unknown as EdgarClient;
}

/** A past quarter, with the derived fields the real feed supplies. */
function q(quarterEnd: string, epsActual: number, epsEstimate: number) {
  return {
    quarterEnd,
    epsActual,
    epsEstimate,
    epsDifference: epsActual - epsEstimate,
    surprisePercent: epsEstimate === 0 ? 0 : ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100,
  };
}

function fakeConsensus(epsActual: number, epsEstimate: number) {
  return {
    get: () =>
      Promise.resolve({
        symbol: 'NVDA',
        currentQuarterEps: epsEstimate,
        currentQuarterRevenue: null,
        nextEarningsDate: null,
        retrievedAt: new Date().toISOString(),
        history: [
          q('2025-03-31', 1.0, 0.98),
          q('2025-06-30', 1.1, 1.08),
          q('2025-09-30', 1.2, 1.19),
          q('2025-12-31', epsActual, epsEstimate),
        ],
      }),
  } as unknown as YahooConsensus;
}

const fakePrices = {
  quote: (s: string) => prices.quote(s),
  bars: () => Promise.resolve(Array.from({ length: 30 }, () => ({ t: '', o: 1, h: 1, l: 1, c: 1, v: 50_000_000 }))),
  clear: vi.fn(),
} as unknown as YahooPriceSource;

// ── Harness ─────────────────────────────────────────────────────────────────

let db: Db;
let bus: SignalBus;
let budget: BudgetGovernor;
let router: OrderRouter;
const lines: string[] = [];

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    db, bus, budget,
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    edgar: fakeEdgar([{ accessionNo: 'acc-1', filedAt: '2026-09-04T20:00:00Z' }], FILING_TEXT),
    consensus: fakeConsensus(2.0, 1.2),   // a large beat
    prices: fakePrices,
    router,
    universe: UNIVERSE,
    sueThreshold: 1.5,
    auditFloor: 70,
    autonomy: 'AUTO',
    ask: scriptedAsk([STRONG_READ, audit(90)]).ask,
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  bus = new SignalBus(db);
  budget = new BudgetGovernor(db, 100, '2026-09-01');
  const adapter = new SimAdapter('sim-us', 'US', prices, US_COSTS, '100000', {
    tickSize: '0.01', lotSize: '1', minNotional: '1',
    supportsFractional: false, supportsShort: false,
  }, { isOpen: () => true });
  router = new OrderRouter({ db, adapter, ledger: new Ledger(db) });
  router.start();
  lines.length = 0;
});

// ── EdgarPollerAgent ────────────────────────────────────────────────────────

describe('EdgarPollerAgent', () => {
  it('emits one signal per new filing and skips non-US names', async () => {
    const p = deps();
    await new EdgarPollerAgent(p).execute();
    const sigs = bus.read(['filing_8k'], 10);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.symbol).toBe('NVDA');
    // BTC has no CIK, so EDGAR was polled exactly once.
    expect(p.edgar.recentEarnings8K).toHaveBeenCalledTimes(1);
  });

  it('does not re-emit a filing it has already seen', async () => {
    const a = new EdgarPollerAgent(deps());
    await a.execute();
    await a.execute();
    expect(bus.read(['filing_8k'], 10)).toHaveLength(1);
  });

  it('seeds from the database so a restart does not replay history', async () => {
    await new EdgarPollerAgent(deps()).execute();
    // A brand-new instance against the same DB must stay quiet.
    await new EdgarPollerAgent(deps()).execute();
    const all = db.prepare(`SELECT COUNT(*) c FROM agent_signals WHERE signal_type='filing_8k'`)
      .get() as { c: number };
    expect(all.c).toBe(1);
  });
});

// ── EarningsReaderAgent ─────────────────────────────────────────────────────

async function runFullCycle(over: Partial<PipelineDeps> = {}): Promise<PipelineDeps> {
  const p = deps(over);
  await new EdgarPollerAgent(p).execute();
  await new EarningsReaderAgent(p).execute();
  return p;
}

function decisions(): { id: number; status: string; source_signal_id: number | null; sue_score: string }[] {
  return db.prepare('SELECT * FROM decisions').all() as never;
}

describe('EarningsReaderAgent', () => {
  it('does not run when there is no filing waiting', () => {
    expect(new EarningsReaderAgent(deps()).shouldRun()).toBe(false);
  });

  it('runs a filing all the way to a placed order', async () => {
    await runFullCycle();
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]!.status).toBe('EXECUTED');
    const orders = db.prepare('SELECT * FROM orders').all() as { symbol: string; side: string }[];
    expect(orders).toHaveLength(1);
    expect(orders[0]!.symbol).toBe('NVDA');
    expect(orders[0]!.side).toBe('buy');
  });

  it('records the originating signal on the decision (INV-2 lineage)', async () => {
    await runFullCycle();
    const d = decisions()[0]!;
    expect(d.source_signal_id).not.toBeNull();
    const sig = db.prepare('SELECT signal_type FROM agent_signals WHERE id = ?')
      .get(d.source_signal_id) as { signal_type: string };
    expect(sig.signal_type).toBe('filing_8k');
  });

  it('consumes the signal so a second pass does not re-read the same filing', async () => {
    const p = await runFullCycle();
    await new EarningsReaderAgent(p).execute();
    expect(decisions()).toHaveLength(1);
  });

  it('places nothing in SHADOW mode but still records the decision', async () => {
    await runFullCycle({ autonomy: 'SHADOW' });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]!.status).toBe('APPROVED');
    expect(db.prepare('SELECT COUNT(*) c FROM orders').get()).toEqual({ c: 0 });
    expect(lines.join('\n')).toContain('SHADOW mode');
  });

  it('stops at the SUE gate when the surprise is weak, before paying for an audit', async () => {
    const s = scriptedAsk([WEAK_READ, audit(95)]);
    await runFullCycle({ ask: s.ask, consensus: fakeConsensus(1.21, 1.2) });
    expect(decisions()).toHaveLength(0);
    // One call — the read. The auditor was never reached.
    expect(s.calls).toHaveLength(1);
  });

  it('refuses to trade below the audit floor', async () => {
    await runFullCycle({ ask: scriptedAsk([STRONG_READ, audit(40)]).ask });
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('below floor');
  });

  it('fails closed when the auditor returns something unparseable', async () => {
    const ask: AskFn = (prompt) =>
      Promise.resolve({
        model: 'haiku',
        text: prompt.includes('audit') || prompt.includes('Audit')
          ? 'the model rambled instead of answering'
          : JSON.stringify(STRONG_READ),
        tokensIn: 1, tokensOut: 1, costUsd: '0', latencyMs: 1, promptHash: 'x',
      } satisfies ClaudeResult);
    await runFullCycle({ ask });
    expect(decisions()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM orders').get()).toEqual({ c: 0 });
  });

  it('skips a filing with no readable exhibit rather than guessing', async () => {
    await runFullCycle({ edgar: fakeEdgar([{ accessionNo: 'a', filedAt: 'x' }], null) });
    expect(decisions()).toHaveLength(0);
    expect(lines.join('\n')).toContain('no EX-99.1');
  });

  it('places nothing once the budget tier forbids entries', async () => {
    budget.record({
      agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1,
      costUsd: '90', latencyMs: 1, ok: true,
    });
    expect(budget.tier()).toBe('ESSENTIAL');
    await runFullCycle();
    expect(decisions()).toHaveLength(0);
  });

  it('emits a scored signal other agents can consume', async () => {
    await runFullCycle();
    const scored = bus.read(['earnings_scored'], 5);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.confidence).toBe(90);
  });
});

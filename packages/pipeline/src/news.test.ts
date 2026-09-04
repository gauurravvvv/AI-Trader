import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import type { NewsItem, YahooNewsSource } from '@aegis/marketdata';
import { NewsScoutAgent, interleave, SIG_NEWS, type NewsDeps } from './news.js';
import type { UniverseEntry } from './universe.js';

const UNIVERSE: UniverseEntry[] = [
  { symbol: 'NVDA', cik: '1045810', market: 'US', name: 'NVIDIA' },
  { symbol: 'BTC', cik: null, market: 'CRYPTO', name: 'Bitcoin' },
  { symbol: 'RELIANCE', cik: null, market: 'IN', name: 'Reliance Industries' },
];

/**
 * `age` is minutes before now, so a fixture controls its own ordering.
 *
 * Stamping every story with `new Date()` looked deterministic and was not:
 * building twenty of them can straddle a millisecond, and `newestFirst` then
 * reorders them. The test passed alone and failed under full-suite load, which
 * is the worst way for a fixture to be wrong.
 */
function story(symbol: string, id: string, title: string, ageMin = 0): NewsItem {
  return {
    id, symbol, title, publisher: 'Reuters', link: `https://x/${id}`,
    publishedAt: new Date(Date.now() - ageMin * 60_000).toISOString(),
    relatedTickers: [symbol],
  };
}

/** A news source with a fixed corpus and a real once-only guard. */
function fakeNews(corpus: Record<string, NewsItem[]>): YahooNewsSource {
  const seen = new Set<string>();
  return {
    headlines: vi.fn((symbol: string) => Promise.resolve(corpus[symbol] ?? [])),
    isNew: (id: string) => (seen.has(id) ? false : (seen.add(id), true)),
  } as unknown as YahooNewsSource;
}

const reply = (text: string): AskFn => () =>
  Promise.resolve({
    model: 'haiku', text, tokensIn: 10, tokensOut: 10,
    costUsd: '0.0001', latencyMs: 5, promptHash: 'h',
    cacheReadTokens: 27414, cacheCreateTokens: 0, costMeasured: true,
  } satisfies ClaudeResult);

let db: Db;
let bus: SignalBus;
let budget: BudgetGovernor;
const lines: string[] = [];

function deps(over: Partial<NewsDeps> = {}): NewsDeps {
  return {
    db, bus, budget,
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    news: fakeNews({}),
    edgar: {} as never,
    consensus: {} as never,
    prices: {} as never,
    router: {} as never,
    universe: UNIVERSE,
    sueThreshold: 1.5,
    auditFloor: 70,
    autonomy: 'SHADOW',
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  bus = new SignalBus(db);
  budget = new BudgetGovernor(db, 100, '2026-09-01');
  lines.length = 0;
});

describe('NewsScoutAgent', () => {
  it('emits a signal for a material story with a clear direction', async () => {
    const d = deps({
      news: fakeNews({ NVDA: [story('NVDA', 'n1', 'NVIDIA wins $14bn AI contract')] }),
      ask: reply('{"items":[{"i":0,"materiality":85,"direction":0.9,"category":"PRODUCT","why":"large contract"}]}'),
    });
    await new NewsScoutAgent(d).execute();
    const sigs = bus.read([SIG_NEWS], 10);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.symbol).toBe('NVDA');
    expect(sigs[0]!.confidence).toBe(77);       // 0.85 * 0.9 rounded
    expect((sigs[0]!.data as { category: string }).category).toBe('PRODUCT');
  });

  it('stays silent on a price recap the model rated as noise', async () => {
    const d = deps({
      news: fakeNews({ NVDA: [story('NVDA', 'n1', 'Nvidia stock rises 4% Tuesday')] }),
      ask: reply('{"items":[{"i":0,"materiality":10,"direction":0.2,"category":"NOISE","why":"reports the move"}]}'),
    });
    await new NewsScoutAgent(d).execute();
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(0);
    expect(lines.join('\n')).toContain('below 0.45');
  });

  it('suppresses a material story whose direction is unclear', async () => {
    const d = deps({
      news: fakeNews({ NVDA: [story('NVDA', 'n1', 'Nvidia faces antitrust review')] }),
      ask: reply('{"items":[{"i":0,"materiality":90,"direction":0,"category":"REGULATORY","why":"sign unclear"}]}'),
    });
    await new NewsScoutAgent(d).execute();
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(0);
  });

  it('covers crypto, which EDGAR cannot reach at all', async () => {
    const d = deps({
      news: fakeNews({ BTC: [story('BTC', 'b1', 'Bitcoin rallies after surprise Fed signal')] }),
      ask: reply('{"items":[{"i":0,"materiality":75,"direction":0.7,"category":"MACRO","why":"rate expectations"}]}'),
    });
    await new NewsScoutAgent(d).execute();
    expect(bus.read([SIG_NEWS], 10)[0]!.symbol).toBe('BTC');
  });

  it('triages the whole universe in one call, not one per symbol', async () => {
    const ask = vi.fn(reply(
      '{"items":[{"i":0,"materiality":80,"direction":0.8,"category":"MA","why":"a"},' +
      '{"i":1,"materiality":80,"direction":-0.8,"category":"LEGAL","why":"b"}]}',
    ));
    await new NewsScoutAgent(deps({
      news: fakeNews({
        NVDA: [story('NVDA', 'n1', 'Nvidia to acquire a rival')],
        BTC: [story('BTC', 'b1', 'Exchange hacked')],
      }),
      ask,
    })).execute();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(2);
  });

  it('does not re-triage a story it has already seen', async () => {
    const ask = vi.fn(reply('{"items":[{"i":0,"materiality":80,"direction":0.9,"category":"MA","why":"a"}]}'));
    const d = deps({ news: fakeNews({ NVDA: [story('NVDA', 'n1', 'Nvidia to acquire a rival')] }), ask });
    const agent = new NewsScoutAgent(d);
    await agent.execute();
    await agent.execute();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(1);
  });

  it('reports a symbol with no attributable news rather than inventing some', async () => {
    await new NewsScoutAgent(deps({ news: fakeNews({}) })).execute();
    expect(lines.join('\n')).toContain('RELIANCE: no attributable news');
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(0);
  });

  it('spends nothing when there is nothing new', async () => {
    const ask = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({ news: fakeNews({}), ask })).execute();
    expect(ask).not.toHaveBeenCalled();
  });

  it('caps the batch so one noisy symbol cannot blow the budget', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      story('NVDA', `n${String(i)}`, `headline ${String(i)}`, i));
    const ask = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({ news: fakeNews({ NVDA: many }), ask, batchCap: 5 })).execute();
    const prompt = ask.mock.calls[0]![0] as string;
    expect(prompt).toContain('4. headline 4');
    expect(prompt).not.toContain('5. headline 5');
  });

  it('stands down once the budget tier drops below NORMAL', () => {
    budget.record({ agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1, costUsd: '75', latencyMs: 1, ok: true });
    expect(new NewsScoutAgent(deps()).shouldRun()).toBe(false);
  });

  it('emits nothing when the model reply is unparseable', async () => {
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: [story('NVDA', 'n1', 'x')] }),
      ask: reply('the first one looks bullish to me'),
    })).execute();
    expect(bus.read([SIG_NEWS], 10)).toHaveLength(0);
    expect(lines.join('\n')).toContain('triage failed');
  });
});

describe('interleave', () => {
  it('gives every symbol its first headline before any gets its second', () => {
    expect(interleave([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']], 10))
      .toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  it('stops at the cap', () => {
    expect(interleave([['a1', 'a2'], ['b1', 'b2']], 3)).toEqual(['a1', 'b1', 'a2']);
  });

  it('handles an empty universe', () => {
    expect(interleave([], 5)).toEqual([]);
  });
});

describe('batch fairness across markets', () => {
  it('does not let the heavily covered US names crowd out crypto and India', async () => {
    // The first live run capped at 12 and never reached BTC: NVDA and AAPL,
    // being the most written-about, consumed the entire batch.
    const many = (sym: string): NewsItem[] =>
      Array.from({ length: 20 }, (_, i) =>
        story(sym, `${sym}${String(i)}`, `${sym} headline ${String(i)}`, i));
    const ask = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: many('NVDA'), BTC: many('BTC'), RELIANCE: many('RELIANCE') }),
      ask,
      batchCap: 6,
    })).execute();
    const prompt = ask.mock.calls[0]![0] as string;
    expect(prompt).toContain('NVDA headline 0');
    expect(prompt).toContain('BTC headline 0');
    expect(prompt).toContain('RELIANCE headline 0');
  });
});

describe('cap starvation', () => {
  it('warns rather than silently ignoring the tail of the universe', async () => {
    const one = (s: string): NewsItem[] => [story(s, `${s}1`, `${s} news`)];
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: one('NVDA'), BTC: one('BTC'), RELIANCE: one('RELIANCE') }),
      ask: reply('{"items":[]}'),
      batchCap: 2,
    })).execute();
    expect(lines.join('\n')).toContain('will not be looked at this tick');
  });

  it('stays quiet when the cap covers every symbol', async () => {
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: [story('NVDA', 'n1', 'x')] }),
      ask: reply('{"items":[]}'),
    })).execute();
    expect(lines.join('\n')).not.toContain('will not be looked at');
  });
});

describe('sweep cadence', () => {
  it('defaults to 20 minutes — the interval is the monthly bill', () => {
    // A measured tick costs ~$0.0146. Every 10 minutes is ~$63/month against a
    // $100 pool; every 20 leaves room for the earnings reader and the auditor.
    expect(new NewsScoutAgent(deps()).intervalMs).toBe(20 * 60 * 1000);
  });

  it('honours an override', () => {
    expect(new NewsScoutAgent(deps({ intervalMinutes: 5 })).intervalMs).toBe(5 * 60 * 1000);
  });
});

describe('ordering determinism', () => {
  it('sends the newest headline for a symbol first', async () => {
    // Regression: the fixture used to stamp every story with new Date(), which
    // straddles a millisecond under load and silently reordered the batch.
    const ask = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({
      news: fakeNews({
        NVDA: [
          story('NVDA', 'old', 'NVDA older story', 120),
          story('NVDA', 'new', 'NVDA newer story', 5),
        ],
      }),
      ask,
    })).execute();
    const prompt = ask.mock.calls[0]![0] as string;
    expect(prompt.indexOf('NVDA newer story')).toBeLessThan(prompt.indexOf('NVDA older story'));
  });
});

describe('dedupe survives a restart', () => {
  it('does not re-triage a story a previous process already read', async () => {
    // The Map version could not tell a restart from a new story, so one Adobe
    // headline went to the model thirteen times at six different scores.
    const corpus = { NVDA: [story('NVDA', 'stable-id', 'Nvidia wins a contract')] };
    const askA = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({ news: fakeNews(corpus), ask: askA })).execute();
    expect(askA).toHaveBeenCalledTimes(1);

    // A brand new source AND a new agent — i.e. a restarted daemon — against
    // the same database.
    const askB = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({ news: fakeNews(corpus), ask: askB })).execute();
    expect(askB).not.toHaveBeenCalled();
  });

  it('records each story once, however many times it is offered', async () => {
    const corpus = { NVDA: [story('NVDA', 'dupe', 'x')] };
    for (let i = 0; i < 3; i += 1) {
      await new NewsScoutAgent(deps({ news: fakeNews(corpus), ask: reply('{"items":[]}') })).execute();
    }
    const n = db.prepare(`SELECT COUNT(*) c FROM seen_news WHERE news_id = 'dupe'`).get();
    expect(n).toEqual({ c: 1 });
  });

  it('still reads a genuinely new story after an old one is seen', async () => {
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: [story('NVDA', 'first', 'a')] }), ask: reply('{"items":[]}'),
    })).execute();
    const ask = vi.fn(reply('{"items":[]}'));
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: [story('NVDA', 'first', 'a'), story('NVDA', 'second', 'b')] }), ask,
    })).execute();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toContain('b');
    expect(ask.mock.calls[0]![0]).not.toContain('0. a');
  });

  it('forgets stories older than the retention window', async () => {
    db.prepare(
      `INSERT INTO seen_news (news_id, symbol, first_seen) VALUES ('ancient','NVDA', datetime('now','-30 days'))`,
    ).run();
    await new NewsScoutAgent(deps({
      news: fakeNews({ NVDA: [story('NVDA', 'ancient', 'back again')] }), ask: reply('{"items":[]}'),
    })).execute();
    // Purged, so it counts as new again — and the row is re-created.
    const rows = db.prepare(`SELECT first_seen FROM seen_news WHERE news_id='ancient'`).all();
    expect(rows).toHaveLength(1);
  });
});

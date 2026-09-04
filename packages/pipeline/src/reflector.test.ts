import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import type { YahooPriceSource } from '@aegis/marketdata';
import { ReflectorAgent, classify, groupLessons, type ReflectorDeps } from './reflector.js';

describe('classify', () => {
  it('calls a trade that beat the market an alpha win', () => {
    expect(classify(0.12, 0.04).verdict).toBe('ALPHA_WIN');
  });

  it('refuses to call a lagging winner a win', () => {
    // +8% in a +12% market is not skill, and scoring it as skill teaches the
    // system to repeat whatever it did in a bull market.
    const o = classify(0.08, 0.12);
    expect(o.verdict).toBe('MARKET_CARRIED');
    expect(o.alphaReturn).toBeCloseTo(-0.04);
  });

  it('credits a loss that beat a worse market', () => {
    // -3% in a -10% market was a good decision that lost money. Punishing it
    // teaches the system to stop trading when it adds the most value.
    expect(classify(-0.03, -0.1).verdict).toBe('MARKET_MASKED');
  });

  it('calls a loss in a rising market an alpha loss', () => {
    expect(classify(-0.05, 0.03).verdict).toBe('ALPHA_LOSS');
  });

  it('treats a flat trade in a flat market as carried, not a win', () => {
    expect(classify(0, 0).verdict).toBe('MARKET_CARRIED');
  });
});

// ── The agent ───────────────────────────────────────────────────────────────

let db: Db;
const lines: string[] = [];
let benchFirst = 100;
let benchLast = 100;

const prices = {
  bars: () => Promise.resolve([
    { t: '', o: 1, h: 1, l: 1, c: benchFirst, v: 1 },
    { t: '', o: 1, h: 1, l: 1, c: benchLast, v: 1 },
  ]),
} as unknown as YahooPriceSource;

const reply = (text: string): AskFn => () =>
  Promise.resolve({
    model: 'haiku', text, tokensIn: 100, tokensOut: 30,
    costUsd: '0.0028', latencyMs: 3400, promptHash: 'h',
    cacheReadTokens: 27414, cacheCreateTokens: 0, costMeasured: true,
  } satisfies ClaudeResult);

const GOOD = '{"category":"entered-after-the-move","lesson":"The story was already priced; wait for a pullback next time.","confidence":75}';

function deps(over: Partial<ReflectorDeps> = {}): ReflectorDeps {
  return {
    db, bus: new SignalBus(db),
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    prices,
    edgar: {} as never, consensus: {} as never, router: {} as never,
    universe: [], sueThreshold: 1.5, auditFloor: 70, autonomy: 'AUTO',
    ask: reply(GOOD),
    ...over,
  };
}

function closeTrade(symbol: string, entry: string, pnl: string, rationale = 'guidance raised'): number {
  const d = db.prepare(
    `INSERT INTO decisions (symbol, market, venue, side, rationale, status)
     VALUES (?, 'US', 'sim-us', 'buy', ?, 'EXECUTED')`,
  ).run(symbol, rationale);
  db.prepare(
    `INSERT INTO positions (venue, symbol, qty, avg_cost, realised_pnl, opened_at, closed_at)
     VALUES ('sim-us', ?, '0', ?, ?, '2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z')`,
  ).run(symbol, entry, pnl);
  return Number(d.lastInsertRowid);
}

beforeEach(() => {
  db = openDb(':memory:');
  lines.length = 0;
  benchFirst = 100;
  benchLast = 100;
});

describe('ReflectorAgent', () => {
  it('does not run with nothing closed', () => {
    expect(new ReflectorAgent(deps()).shouldRun()).toBe(false);
  });

  it('records a lesson for a closed trade', async () => {
    closeTrade('NVDA', '100', '12');
    await new ReflectorAgent(deps()).execute();
    const l = db.prepare('SELECT * FROM lessons').get() as { category: string; verdict: string; symbol: string };
    expect(l.symbol).toBe('NVDA');
    expect(l.category).toBe('entered-after-the-move');
  });

  it('scores a lagging winner against the market, not against zero', async () => {
    benchFirst = 100; benchLast = 112;        // market +12%
    closeTrade('NVDA', '100', '8');           // trade +8%
    await new ReflectorAgent(deps()).execute();
    const l = db.prepare('SELECT verdict, alpha_return FROM lessons').get() as
      { verdict: string; alpha_return: number };
    expect(l.verdict).toBe('MARKET_CARRIED');
    expect(l.alpha_return).toBeCloseTo(-0.04, 3);
  });

  it('credits a loss that beat a falling market', async () => {
    benchFirst = 100; benchLast = 90;         // market -10%
    closeTrade('NVDA', '100', '-3');          // trade -3%
    await new ReflectorAgent(deps()).execute();
    expect((db.prepare('SELECT verdict FROM lessons').get() as { verdict: string }).verdict)
      .toBe('MARKET_MASKED');
  });

  it('reflects on a trade exactly once', async () => {
    closeTrade('NVDA', '100', '12');
    const a = new ReflectorAgent(deps());
    await a.execute();
    await a.execute();
    expect(db.prepare('SELECT COUNT(*) c FROM lessons').get()).toEqual({ c: 1 });
  });

  it('caps how many it reflects on per tick so a busy week is not a budget event', async () => {
    for (const s of ['NVDA', 'AMD', 'INTC', 'MU', 'AVGO']) closeTrade(s, '100', '5');
    const ask = vi.fn(reply(GOOD));
    await new ReflectorAgent(deps({ ask }), 2).execute();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('attributes the lesson to the agent that opened the trade', async () => {
    closeTrade('NVDA', '100', '5', 'news: big contract — Nvidia wins deal');
    await new ReflectorAgent(deps()).execute();
    expect((db.prepare('SELECT source FROM lessons').get() as { source: string }).source).toBe('news');
  });

  it('keeps reflecting however much has been spent', () => {
    closeTrade('NVDA', '100', '5');
    const d = deps();
    d.budget.record({ agent: 't', model: 'haiku', tokensIn: 1, tokensOut: 1, costUsd: '9999', latencyMs: 1, ok: true });
    expect(new ReflectorAgent(d).shouldRun()).toBe(true);
  });

  it('stands down while a plan usage limit is in force', () => {
    closeTrade('NVDA', '100', '5');
    const d = deps();
    d.budget.pause(Date.now() + 600_000, 'usage limit');
    expect(new ReflectorAgent(d).shouldRun()).toBe(false);
  });

  it('records nothing when the model reply is unparseable', async () => {
    closeTrade('NVDA', '100', '5');
    await new ReflectorAgent(deps({ ask: reply('I think it went fine.') })).execute();
    expect(db.prepare('SELECT COUNT(*) c FROM lessons').get()).toEqual({ c: 0 });
    expect(lines.join('\n')).toContain('unparseable lesson');
  });

  it('refuses to judge alpha with no benchmark history', async () => {
    closeTrade('NVDA', '100', '5');
    const d = deps({ prices: { bars: () => Promise.resolve([]) } as unknown as YahooPriceSource });
    await new ReflectorAgent(d).execute();
    expect(db.prepare('SELECT COUNT(*) c FROM lessons').get()).toEqual({ c: 0 });
    expect(lines.join('\n')).toContain('cannot judge alpha');
  });
});

describe('groupLessons', () => {
  it('surfaces the categories costing the most alpha first', () => {
    const rows: [string, number][] = [
      ['sizing-too-large', -0.08], ['sizing-too-large', -0.06],
      ['sound-decision-noisy-outcome', 0.01],
    ];
    for (const [category, alpha] of rows) {
      db.prepare(
        `INSERT INTO lessons (symbol, venue, raw_return, benchmark_return, alpha_return, verdict, category, lesson)
         VALUES ('X','sim-us',0,0,?, 'ALPHA_LOSS', ?, 'because')`,
      ).run(alpha, category);
    }
    const g = groupLessons(db);
    expect(g[0]!.category).toBe('sizing-too-large');
    expect(g[0]!.count).toBe(2);
    expect(g[0]!.meanAlpha).toBeCloseTo(-0.07);
  });

  it('returns nothing when nothing has been learned yet', () => {
    expect(groupLessons(db)).toEqual([]);
  });
});

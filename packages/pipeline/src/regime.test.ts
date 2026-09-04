import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { SignalBus } from '@aegis/agents';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import type { YahooPriceSource } from '@aegis/marketdata';
import { MarketRegimeAgent, classifyRegime, sizeMultiplier, currentRegime, SIG_REGIME } from './regime.js';
import type { RegimeDeps } from './regime.js';

/** A smooth series with the given total drift over `n` steps. */
const drift = (n: number, total: number, start = 100): number[] =>
  Array.from({ length: n }, (_, i) => start * (1 + (total * i) / (n - 1)));

/** A series that ends where it started but swings hard on the way. */
const choppy = (n: number, amp: number, start = 100): number[] =>
  Array.from({ length: n }, (_, i) => start * (1 + (i % 2 === 0 ? amp : -amp)));

describe('classifyRegime', () => {
  it('calls a steady advance with wide participation risk-on', () => {
    expect(classifyRegime(drift(20, 0.04), 0.8).regime).toBe('RISK_ON');
  });

  it('calls a decline risk-off', () => {
    expect(classifyRegime(drift(20, -0.05), 0.4).regime).toBe('RISK_OFF');
  });

  it('refuses to call a violent rally risk-on', () => {
    // Volatility overrides trend. A market rising fast on wide daily swings can
    // hand the move back overnight, and sizing into it on the trend alone is
    // how a good week is given up in one session.
    const violent = choppy(20, 0.05);
    const r = classifyRegime(violent, 0.9);
    expect(r.regime).toBe('RISK_OFF');
    expect(r.detail).toContain('not trustworthy');
  });

  it('calls a rising index with narrow breadth risk-off', () => {
    // A handful of names carrying the tape is not a healthy market.
    expect(classifyRegime(drift(20, 0.04), 0.2).regime).toBe('RISK_OFF');
  });

  it('sits neutral on a drifting market', () => {
    expect(classifyRegime(drift(20, 0.002), 0.5).regime).toBe('NEUTRAL');
  });

  it('admits it cannot judge on too little history', () => {
    const r = classifyRegime([100, 101], 0.6);
    expect(r.regime).toBe('NEUTRAL');
    expect(r.detail).toContain('not enough');
  });

  it('does not divide by a zero price', () => {
    expect(() => classifyRegime([0, 0, 0, 0, 0, 0], 0.5)).not.toThrow();
  });
});

describe('sizeMultiplier', () => {
  it('shrinks longs but not shorts when the market is falling', () => {
    // Risk-off does not stop trading: a bearish read is worth MORE in a falling
    // market, not less.
    expect(sizeMultiplier('RISK_OFF', 'long')).toBeLessThan(0.5);
    expect(sizeMultiplier('RISK_OFF', 'short')).toBe(1);
  });

  it('does the reverse when the market is rising', () => {
    expect(sizeMultiplier('RISK_ON', 'long')).toBe(1);
    expect(sizeMultiplier('RISK_ON', 'short')).toBeLessThan(1);
  });

  it('trims both in a neutral tape', () => {
    expect(sizeMultiplier('NEUTRAL', 'long')).toBeLessThan(1);
    expect(sizeMultiplier('NEUTRAL', 'short')).toBeLessThan(1);
  });
});

describe('currentRegime', () => {
  it('reads the latest signal', () => {
    expect(currentRegime([{ data: { regime: 'RISK_OFF' } }])).toBe('RISK_OFF');
  });
  it('defaults to neutral with nothing to read', () => {
    expect(currentRegime([])).toBe('NEUTRAL');
    expect(currentRegime(undefined)).toBe('NEUTRAL');
    expect(currentRegime([{ data: { regime: 'nonsense' } }])).toBe('NEUTRAL');
  });
});

// ── The agent ───────────────────────────────────────────────────────────────

let db: Db;
let bus: SignalBus;
const lines: string[] = [];

function priceSource(index: number[], memberAbove: boolean): YahooPriceSource {
  return {
    bars: (symbol: string) =>
      Promise.resolve(
        (symbol === 'SPY'
          ? index
          : memberAbove
            ? drift(25, 0.1)
            : drift(25, -0.1)
        ).map((c) => ({ t: '', o: c, h: c, l: c, c, v: 1e6 })),
      ),
  } as unknown as YahooPriceSource;
}

function deps(over: Partial<RegimeDeps> = {}): RegimeDeps {
  return {
    db, bus,
    budget: new BudgetGovernor(db, 100, '2026-09-01'),
    log: createLogger({ colour: false, sink: (l) => lines.push(l) }),
    prices: priceSource(drift(25, 0.04), true),
    edgar: {} as never, consensus: {} as never, router: {} as never,
    universe: [
      { symbol: 'NVDA', cik: null, market: 'US', name: 'NVIDIA' },
      { symbol: 'AAPL', cik: null, market: 'US', name: 'Apple' },
    ],
    sueThreshold: 1.5, auditFloor: 70, autonomy: 'AUTO',
    ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  bus = new SignalBus(db);
  lines.length = 0;
});

describe('MarketRegimeAgent', () => {
  it('emits a regime signal other agents can read', async () => {
    await new MarketRegimeAgent(deps()).execute();
    const s = bus.read([SIG_REGIME], 5);
    expect(s).toHaveLength(1);
    expect((s[0]!.data as { regime: string }).regime).toBe('RISK_ON');
  });

  it('reports risk-off when the members are below their averages', async () => {
    const d = deps({ prices: priceSource(drift(25, 0.04), false) });
    await new MarketRegimeAgent(d).execute();
    expect((bus.read([SIG_REGIME], 5)[0]!.data as { regime: string }).regime).toBe('RISK_OFF');
  });

  it('spends no model credit — the regime must survive an exhausted budget', async () => {
    const d = deps();
    await new MarketRegimeAgent(d).execute();
    expect(d.budget.spent()).toBe('0');
  });

  it('says so rather than guessing when the index has no history', async () => {
    const d = deps({ prices: { bars: () => Promise.resolve([]) } as unknown as YahooPriceSource });
    await new MarketRegimeAgent(d).execute();
    expect(bus.read([SIG_REGIME], 5)).toHaveLength(0);
    expect(lines.join('\n')).toContain('not enough history');
  });
});

import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from './env.js';

const base = { TRADING_MODE: 'paper', DB_PATH: './data/aegis.db' };

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const c = loadConfig(base);
    expect(c.tradingMode).toBe('paper');
    expect(c.monthlyBudgetUsd).toBe(100);
    expect(c.claudeConcurrency).toBe(3);
    expect(c.sueThreshold).toBe(1.5);
  });

  it('rejects any TRADING_MODE other than the literal "paper" (INV-1)', () => {
    for (const bad of ['live', 'PAPER', 'Paper', '']) {
      expect(() => loadConfig({ ...base, TRADING_MODE: bad })).toThrow(ConfigError);
    }
  });

  it('fails loud on a malformed boolean instead of defaulting', () => {
    expect(() => loadConfig({ ...base, VERBOSE: 'treu' })).toThrow(/VERBOSE/);
  });

  it('fails loud on a non-numeric budget', () => {
    expect(() => loadConfig({ ...base, MONTHLY_BUDGET_USD: 'lots' })).toThrow(/MONTHLY_BUDGET_USD/);
  });

  it('rejects a budget outside sane bounds', () => {
    expect(() => loadConfig({ ...base, MONTHLY_BUDGET_USD: '0' })).toThrow(/MONTHLY_BUDGET_USD/);
    expect(() => loadConfig({ ...base, MONTHLY_BUDGET_USD: '99999' })).toThrow(/MONTHLY_BUDGET_USD/);
  });

  it('rejects a claude concurrency above 8 — each call is a full node process', () => {
    expect(() => loadConfig({ ...base, CLAUDE_CONCURRENCY: '50' })).toThrow(/CLAUDE_CONCURRENCY/);
  });

  it('throws when a required variable is missing', () => {
    // Deliberately omits DB_PATH — that is the point of the test.
    expect(() => loadConfig({ TRADING_MODE: 'paper' })).toThrow(/DB_PATH/);
  });
});

describe('debate models', () => {
  it('defaults to the cheap model proposing and the expensive one vetoing', () => {
    const c = loadConfig(base);
    expect(c.analystModel).toBe('haiku');
    expect(c.challengerModel).toBe('sonnet');
  });

  it('accepts an override', () => {
    const c = loadConfig({ ...base, ANALYST_MODEL: 'sonnet', CHALLENGER_MODEL: 'haiku' });
    expect(c.analystModel).toBe('sonnet');
    expect(c.challengerModel).toBe('haiku');
  });

  it('refuses a model that does not exist rather than falling back silently', () => {
    expect(() => loadConfig({ ...base, ANALYST_MODEL: 'gpt-4' })).toThrow('ANALYST_MODEL');
  });
});

describe('limits', () => {
  it('has usable defaults', () => {
    const c = loadConfig(base);
    expect(c.maxOpenPositions).toBe(8);
    expect(c.maxTradesPerDay).toBe(5);
    // A runaway-loop backstop, not a daily allowance.
    expect(c.maxAnalysesPerDay).toBe(400);
    expect(c.baseSizePct).toBeCloseTo(0.03);
  });

  it('reads overrides', () => {
    const c = loadConfig({
      ...base, MAX_OPEN_POSITIONS: '3',
      MAX_TRADES_PER_DAY: '2', MAX_ANALYSES_PER_DAY: '4', BASE_SIZE_PCT: '0.01',
    });
    expect(c.maxOpenPositions).toBe(3);
    expect(c.maxTradesPerDay).toBe(2);
    expect(c.maxAnalysesPerDay).toBe(4);
    expect(c.baseSizePct).toBeCloseTo(0.01);
  });

  it('refuses a position size that would bet the account on one name', () => {
    expect(() => loadConfig({ ...base, BASE_SIZE_PCT: '0.9' })).toThrow('BASE_SIZE_PCT');
  });
});

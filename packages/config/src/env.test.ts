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
    expect(() => loadConfig({ TRADING_MODE: 'paper' })).toThrow(/DB_PATH/);
  });
});

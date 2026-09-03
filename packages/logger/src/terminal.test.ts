import { describe, it, expect } from 'vitest';
import { formatLine, formatLlm, formatBudget, formatCost } from './terminal.js';

const at = new Date('2026-09-03T14:32:07Z');
const ESC = String.fromCharCode(27);
// Timestamps render in LOCAL time, so the expectation is derived rather than
// hardcoded — otherwise this test only passes in UTC.
const localHHMMSS = [at.getHours(), at.getMinutes(), at.getSeconds()]
  .map((n) => String(n).padStart(2, '0'))
  .join(':');

describe('formatLine', () => {
  it('renders time, agent, glyph and message', () => {
    const s = formatLine({
      at, agent: 'edgar-poller', kind: 'event', msg: '8-K detected  NVDA', colour: false,
    });
    expect(s).toContain('edgar-poller');
    expect(s).toContain('▸');
    expect(s).toContain('8-K detected  NVDA');
    expect(s.startsWith(localHHMMSS)).toBe(true);
  });

  it('pads agent names to a fixed column so the log stays scannable', () => {
    const a = formatLine({ at, agent: 'risk-officer', kind: 'ok', msg: 'x', colour: false });
    const b = formatLine({ at, agent: 'execution', kind: 'ok', msg: 'x', colour: false });
    expect(a.indexOf('✓')).toBe(b.indexOf('✓'));
  });

  it('uses a distinct glyph for every kind', () => {
    const marks = (['event', 'ok', 'warn', 'error', 'llm'] as const).map((k) => {
      const line = formatLine({ at, agent: 'a', kind: k, msg: 'm', colour: false });
      return line.trim().split(/\s+/).at(-2);
    });
    expect(new Set(marks).size).toBe(5);
  });

  it('emits no ANSI escapes when colour is off', () => {
    const s = formatLine({ at, agent: 'a', kind: 'error', msg: 'boom', colour: false });
    expect(s.includes(ESC)).toBe(false);
  });

  it('renders local time, not UTC', () => {
    const s = formatLine({ at, agent: 'a', kind: 'event', msg: 'm', colour: false });
    expect(s.startsWith(localHHMMSS)).toBe(true);
    if (at.getTimezoneOffset() !== 0) {
      expect(s.startsWith('14:32:07')).toBe(false);
    }
  });
});

describe('formatLlm', () => {
  it('shows model, token counts, cost and latency', () => {
    const s = formatLlm({
      at, agent: 'earnings-reader', model: 'sonnet',
      tokensIn: 18412, tokensOut: 1203, costUsd: '0.086000', latencyMs: 11400, colour: false,
    });
    expect(s).toContain('sonnet');
    expect(s).toContain('18,412');
    expect(s).toContain('1,203');
    expect(s).toContain('$0.0860');
    expect(s).toContain('11.4s');
  });
});

describe('formatCost', () => {
  it('does not round a sub-cent haiku call away to $0.000', () => {
    // 107 in / 67 out on haiku = $0.000442. Three decimals renders that as
    // "$0.000", which reads as free.
    expect(formatCost('0.000442')).toBe('$0.000442');
  });

  it('uses four decimals in the sub-dollar range', () => {
    expect(formatCost('0.0864')).toBe('$0.0864');
  });

  it('uses two decimals for dollar amounts', () => {
    expect(formatCost('19.4')).toBe('$19.40');
  });

  it('renders exact zero plainly', () => {
    expect(formatCost('0')).toBe('$0');
  });
});

describe('formatBudget', () => {
  it('shows spend, cap, percentage and days elapsed', () => {
    const s = formatBudget({ spent: '19.40', budget: 100, dayOfCycle: 11, colour: false });
    expect(s).toContain('$19.40');
    expect(s).toContain('$100');
    expect(s).toContain('19%');
    expect(s).toContain('11 days');
  });
});

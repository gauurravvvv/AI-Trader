import { describe, it, expect } from 'vitest';
import { formatLine, formatLlm, formatBudget } from './terminal.js';

const at = new Date('2026-09-03T14:32:07Z');
const ESC = String.fromCharCode(27);

describe('formatLine', () => {
  it('renders time, agent, glyph and message', () => {
    const s = formatLine({
      at, agent: 'edgar-poller', kind: 'event', msg: '8-K detected  NVDA', colour: false,
    });
    expect(s).toContain('edgar-poller');
    expect(s).toContain('▸');
    expect(s).toContain('8-K detected  NVDA');
    expect(s.startsWith('14:32:07')).toBe(true);
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
    expect(s).toContain('$0.086');
    expect(s).toContain('11.4s');
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

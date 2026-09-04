import { describe, it, expect } from 'vitest';
import { formatLine, formatLlm, formatBudget, formatCost } from './terminal.js';
import { createLogger } from './index.js';

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

  it('does not truncate any agent name the system actually uses', () => {
    // Every registered agent, longest first. A truncated name is ungreppable,
    // and 'guardian:sim-crypto' is what forced the column from 18 to 20.
    for (const name of [
      'guardian:sim-crypto',
      'guardian:sim-us',
      'earnings-reader',
      'surprise-scorer',
      'thesis-auditor',
      'edgar-poller',
      'news-trader',
      'news-scout',
      'news-triage',
      'order-router',
      'reconciler',
      'consensus',
      'execution',
      'dashboard',
      'notifier',
      'daemon',
    ]) {
      expect(formatLine({ at, agent: name, kind: 'ok', msg: 'x', colour: false })).toContain(name);
    }
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

describe('level filtering', () => {
  it('suppresses info-level lines at level=warn', () => {
    const seen: string[] = [];
    const log = createLogger({ level: 'warn', colour: false, sink: (l) => seen.push(l) });
    log.event('a', 'routine');
    log.ok('a', 'fine');
    log.warn('a', 'careful');
    log.error('a', 'broken');
    expect(seen).toHaveLength(2);
    expect(seen.join()).toContain('careful');
    expect(seen.join()).toContain('broken');
    expect(seen.join()).not.toContain('routine');
  });

  it('shows everything at level=info (the default)', () => {
    const seen: string[] = [];
    const log = createLogger({ colour: false, sink: (l) => seen.push(l) });
    log.event('a', 'x'); log.warn('a', 'y'); log.error('a', 'z');
    expect(seen).toHaveLength(3);
  });

  it('suppresses all but errors at level=error', () => {
    const seen: string[] = [];
    const log = createLogger({ level: 'error', colour: false, sink: (l) => seen.push(l) });
    log.event('a', 'x'); log.warn('a', 'y'); log.error('a', 'z');
    expect(seen).toHaveLength(1);
  });

  it('never suppresses an LLM cost line below warn — spend must stay visible', () => {
    const seen: string[] = [];
    const log = createLogger({ level: 'info', colour: false, sink: (l) => seen.push(l) });
    log.llm('a', { model: 'haiku', tokensIn: 1, tokensOut: 1, costUsd: '0.01', latencyMs: 1 });
    expect(seen).toHaveLength(1);
  });
});

describe('raw vs debug', () => {
  it('always prints raw — it carries message content, not chatter', () => {
    const seen: string[] = [];
    createLogger({ colour: false, sink: (l) => seen.push(l) }).raw('the body of the email');
    expect(seen).toEqual(['the body of the email']);
  });

  it('prints debug only when verbose', () => {
    const quiet: string[] = [];
    createLogger({ colour: false, sink: (l) => quiet.push(l) }).debug('chatter');
    expect(quiet).toHaveLength(0);

    const loud: string[] = [];
    createLogger({ verbose: true, colour: false, sink: (l) => loud.push(l) }).debug('chatter');
    expect(loud).toEqual(['chatter']);
  });

  it('delivers a notification body through the default console transport', () => {
    // Regression: raw was verbose-gated, so ConsoleTransport — the default
    // notification channel — emitted a subject and dropped the entire body.
    const seen: string[] = [];
    const log = createLogger({ colour: false, sink: (l) => seen.push(l) });
    log.event('notifier', '[email → op] Subject');
    log.raw('  | SELL 10 NVDA @ 89.00\n  | Reason: STOP_LOSS');
    expect(seen.join('\n')).toContain('STOP_LOSS');
  });
});

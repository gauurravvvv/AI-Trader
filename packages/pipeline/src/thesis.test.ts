import { describe, it, expect } from 'vitest';
import { openDb } from '@aegis/db';
import { BudgetGovernor } from '@aegis/budget';
import { createLogger } from '@aegis/logger';
import type { AskFn, ClaudeResult } from '@aegis/claude';
import {
  proposeThesis, challengeThesis, resolveDebate, renderEvidence,
  DEFAULT_DEBATE, type Thesis, type Challenge, type Evidence,
} from './thesis.js';

const log = createLogger({ colour: false, sink: () => undefined });
const budget = (): BudgetGovernor => new BudgetGovernor(openDb(':memory:'), 100, '2026-09-01');

const reply = (text: string): AskFn => () =>
  Promise.resolve({
    model: 'sonnet', text, tokensIn: 3000, tokensOut: 400,
    costUsd: '0.15', latencyMs: 20000, promptHash: 'h',
    cacheReadTokens: 27414, cacheCreateTokens: 0, costMeasured: true,
  } satisfies ClaudeResult);

const evidence: Evidence = {
  symbol: 'NVDA',
  headlines: [
    { title: 'Nvidia wins $14bn AI contract', publisher: 'Reuters', publishedAt: '2026-09-04T10:00:00Z' },
  ],
  movePct: 0.01, move5dPct: 0.03, regime: 'RISK_ON',
};

const thesis = (over: Partial<Thesis> = {}): Thesis => ({
  direction: 'LONG', conviction: 80,
  thesis: 'A large contract win adds revenue not currently in estimates.',
  claims: ['Nvidia won a contract worth $14bn'],
  invalidators: ['The contract is denied or materially smaller'],
  horizonDays: 10, ...over,
});

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  claimVerdicts: [{ claim: 'Nvidia won a contract worth $14bn', verdict: 'SUPPORTED', why: 'stated' }],
  bearCase: 'The size may already be reflected in the price after a three percent run.',
  verdict: 'PROCEED', confidence: 75, oneLine: 'Facts hold, edge is real but modest.', ...over,
});

describe('renderEvidence', () => {
  it('numbers headlines so a claim can point at one', () => {
    expect(renderEvidence(evidence)).toContain('0. [2026-09-04] Nvidia wins $14bn AI contract');
  });
  it('shows both the day and the week, so a move can be seen in context', () => {
    const out = renderEvidence(evidence);
    expect(out).toContain('Move today: 1.00%');
    expect(out).toContain('Move over 5 sessions: 3.00%');
  });
});

describe('proposeThesis', () => {
  it('parses a well-formed thesis', async () => {
    const out = await proposeThesis(evidence, {
      budget: budget(), log, ask: reply(JSON.stringify(thesis())),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.direction).toBe('LONG');
  });

  it('accepts a NONE — declining is a valid answer', async () => {
    const out = await proposeThesis(evidence, {
      budget: budget(), log,
      ask: reply(JSON.stringify(thesis({ direction: 'NONE', conviction: 10 }))),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.direction).toBe('NONE');
  });

  it('rejects a thesis with no checkable claims', async () => {
    const bad = { ...thesis(), claims: [] };
    const out = await proposeThesis(evidence, { budget: budget(), log, ask: reply(JSON.stringify(bad)) });
    expect(out.ok).toBe(false);
  });

  it('proposes however much has been spent', async () => {
    const b = budget();
    b.record({ agent: 't', model: 'sonnet', tokensIn: 1, tokensOut: 1, costUsd: '9999', latencyMs: 1, ok: true });
    const out = await proposeThesis(evidence, {
      budget: b, log, ask: reply(JSON.stringify(thesis())),
    });
    expect(out.ok).toBe(true);
  });

  it('stands down while a plan usage limit is in force', async () => {
    const b = budget();
    b.pause(Date.now() + 600_000, 'usage limit');
    const out = await proposeThesis(evidence, { budget: b, log, ask: reply('{}') });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('paused');
  });

  it('charges the budget for a call that threw', async () => {
    const b = budget();
    await proposeThesis(evidence, { budget: b, log, ask: () => Promise.reject(new Error('spawn failed')) });
    const n = Number(b.spent());
    expect(Number.isFinite(n)).toBe(true);
  });
});

describe('challengeThesis', () => {
  it('gives the challenger the claims to check', async () => {
    let seen = '';
    const out = await challengeThesis(evidence, thesis(), {
      budget: budget(), log,
      ask: (p) => { seen = p; return reply(JSON.stringify(challenge()))(p, { model: 'sonnet', agent: 'x' }); },
    });
    expect(out.ok).toBe(true);
    expect(seen).toContain('Claims to check');
    expect(seen).toContain('Nvidia won a contract worth $14bn');
  });

  it('shows the challenger the same headlines the analyst saw', async () => {
    let seen = '';
    await challengeThesis(evidence, thesis(), {
      budget: budget(), log,
      ask: (p) => { seen = p; return reply(JSON.stringify(challenge()))(p, { model: 'sonnet', agent: 'x' }); },
    });
    expect(seen).toContain('Nvidia wins $14bn AI contract');
  });
});

describe('resolveDebate', () => {
  it('lets a clean thesis through', () => {
    const r = resolveDebate(thesis(), challenge());
    expect(r.trade).toBe(true);
    expect(r.direction).toBe('long');
  });

  it('takes a SHORT as a short, not as a refusal', () => {
    const r = resolveDebate(thesis({ direction: 'SHORT' }), challenge());
    expect(r.trade).toBe(true);
    expect(r.direction).toBe('short');
  });

  it('does not trade when the analyst declined', () => {
    expect(resolveDebate(thesis({ direction: 'NONE' }), challenge()).trade).toBe(false);
  });

  it('does not trade on a REJECT', () => {
    const r = resolveDebate(thesis(), challenge({ verdict: 'REJECT' }));
    expect(r.trade).toBe(false);
    expect(r.reason).toContain('challenger rejected');
  });

  it('refuses outright when a claim is contradicted, however high the conviction', () => {
    // A contradicted claim is not a weak trade, it is a wrong one.
    const r = resolveDebate(
      thesis({ conviction: 99 }),
      challenge({
        verdict: 'PROCEED', confidence: 99,
        claimVerdicts: [{ claim: 'x', verdict: 'CONTRADICTED', why: 'the headline says the opposite' }],
      }),
    );
    expect(r.trade).toBe(false);
    expect(r.reason).toContain('contradicted');
  });

  it('refuses a thesis resting mostly on inference', () => {
    const r = resolveDebate(thesis(), challenge({
      claimVerdicts: [
        { claim: 'a', verdict: 'SUPPORTED', why: '' },
        { claim: 'b', verdict: 'UNSUPPORTED', why: '' },
        { claim: 'c', verdict: 'UNSUPPORTED', why: '' },
      ],
    }));
    expect(r.trade).toBe(false);
    expect(r.reason).toContain('1/3 claims are supported');
  });

  it('refuses low conviction', () => {
    expect(resolveDebate(thesis({ conviction: 40 }), challenge()).trade).toBe(false);
  });

  it('refuses when the challenger doubts its own verdict', () => {
    const r = resolveDebate(thesis(), challenge({ confidence: 30 }));
    expect(r.trade).toBe(false);
    expect(r.reason).toContain('only 30% confident');
  });

  it('sizes a grudging PROCEED_WITH_CAUTION smaller than a clean PROCEED', () => {
    const clean = resolveDebate(thesis(), challenge({ verdict: 'PROCEED' }));
    const cautious = resolveDebate(thesis(), challenge({ verdict: 'PROCEED_WITH_CAUTION' }));
    expect(cautious.strength).toBeLessThan(clean.strength);
    expect(cautious.trade).toBe(true);
  });

  it('scales strength by how much of the thesis actually held up', () => {
    const all = resolveDebate(thesis(), challenge({
      claimVerdicts: [
        { claim: 'a', verdict: 'SUPPORTED', why: '' },
        { claim: 'b', verdict: 'SUPPORTED', why: '' },
      ],
    }));
    const some = resolveDebate(thesis(), challenge({
      claimVerdicts: [
        { claim: 'a', verdict: 'SUPPORTED', why: '' },
        { claim: 'b', verdict: 'UNSUPPORTED', why: '' },
        { claim: 'c', verdict: 'SUPPORTED', why: '' },
      ],
    }));
    expect(some.strength).toBeLessThan(all.strength);
  });

  it('never returns a strength above 1', () => {
    const r = resolveDebate(thesis({ conviction: 100 }), challenge());
    expect(r.strength).toBeLessThanOrEqual(1);
  });

  it('honours a stricter rule', () => {
    const strict = { ...DEFAULT_DEBATE, minConviction: 95 };
    expect(resolveDebate(thesis({ conviction: 80 }), challenge(), strict).trade).toBe(false);
  });
});

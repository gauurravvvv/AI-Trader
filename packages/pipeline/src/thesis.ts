import { z } from 'zod';
import { askClaude, parseModelJson, ClaudeError, type AskFn, type ModelId } from '@aegis/claude';
import type { BudgetGovernor } from '@aegis/budget';
import type { Logger } from '@aegis/logger';

// ── What the analyst produces ───────────────────────────────────────────────

export const ThesisSchema = z.object({
  /** LONG buys, SHORT sells short, NONE declines to take a side. */
  direction: z.enum(['LONG', 'SHORT', 'NONE']),
  conviction: z.number().min(0).max(100),
  /** One paragraph. Why the price should move, not what happened. */
  thesis: z.string().min(20).max(900),
  /**
   * Each claim must be checkable against the supplied headlines alone.
   * This is what makes the challenger's job possible.
   */
  claims: z.array(z.string().min(8).max(240)).min(1).max(5),
  /** What would prove this wrong. */
  invalidators: z.array(z.string().min(8).max(240)).min(1).max(4),
  /** Horizon in trading days. */
  horizonDays: z.number().int().min(1).max(60),
});

export type Thesis = z.infer<typeof ThesisSchema>;

const ANALYST_PROMPT = `You are a directional equity analyst. Given recent headlines about one
company and its recent price action, decide whether to be LONG, SHORT, or neither.

Hard rules:
- Every claim you make must be checkable against the headlines below and nothing
  else. Do not use anything you remember about this company. If the headlines do
  not support a view, the answer is NONE.
- NONE is the right answer most of the time. A headline is written to be clicked.
- Do not confuse a report of a move with a cause of one. "Stock rose 4%" is not a
  reason to be long.
- direction is about the NEXT few days, not the last few.
- conviction above 70 requires a specific, dated, material fact — not a theme.

Return ONLY JSON, no prose and no code fences:
{"direction":"LONG|SHORT|NONE","conviction":0-100,"thesis":"one paragraph",
 "claims":["checkable against the headlines"],"invalidators":["what would disprove it"],
 "horizonDays":1-60}

`;

// ── What the challenger produces ────────────────────────────────────────────

export const ChallengeSchema = z.object({
  /** One verdict per claim, in the order the claims were given. */
  claimVerdicts: z
    .array(
      z.object({
        claim: z.string(),
        verdict: z.enum(['SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED']),
        why: z.string().max(240),
      }),
    )
    .min(1),
  /** The strongest case against the trade. */
  bearCase: z.string().min(20).max(900),
  /** Whether the thesis survives. */
  verdict: z.enum(['PROCEED', 'PROCEED_WITH_CAUTION', 'REJECT']),
  confidence: z.number().min(0).max(100),
  oneLine: z.string().max(240),
});

export type Challenge = z.infer<typeof ChallengeSchema>;

const CHALLENGER_PROMPT = `You are the opposing side of a trading debate. Another analyst has proposed a
trade. Your job is BOTH to check their facts and to argue against them.

For each claim, decide against the headlines below ONLY:
- SUPPORTED   the headlines state this
- UNSUPPORTED the headlines neither state nor contradict it — the analyst inferred it
- CONTRADICTED the headlines say otherwise

An inference is not a fact. If the analyst wrote "demand is accelerating" and the
headline says "company announces new product", that is UNSUPPORTED.

Then argue the other side properly: the strongest case for why this trade loses
money, including what the analyst has not considered.

Then a verdict:
- REJECT if any claim is CONTRADICTED, or if the thesis rests mainly on
  UNSUPPORTED claims, or if the bear case is stronger than the thesis.
- PROCEED_WITH_CAUTION if the facts hold but the edge is thin.
- PROCEED only if the facts hold and the bear case is genuinely weaker.

Default to REJECT. Most proposed trades should not be taken.

Return ONLY JSON, no prose and no code fences:
{"claimVerdicts":[{"claim":"...","verdict":"SUPPORTED|UNSUPPORTED|CONTRADICTED","why":"..."}],
 "bearCase":"one paragraph","verdict":"PROCEED|PROCEED_WITH_CAUTION|REJECT",
 "confidence":0-100,"oneLine":"under 30 words"}

`;

export interface ThesisDeps {
  budget: BudgetGovernor;
  log: Logger;
  ask?: AskFn;
  /**
   * Measured on this machine: haiku is ~$0.003 a call and sonnet ~$0.05 even
   * with a warm cache, because sonnet's cached-input price is ten times haiku's.
   *
   * The defaults put the cheap model on generation and the expensive one on the
   * veto. Forming a view from a handful of headlines is within haiku's range;
   * the step that stops money moving is worth paying for. Both are overridable
   * because that trade-off is a judgement, not a fact.
   */
  analystModel?: ModelId;
  challengerModel?: ModelId;
}

export interface Evidence {
  symbol: string;
  headlines: { title: string; publisher: string; publishedAt: string }[];
  /** Move on the day, as a fraction. */
  movePct: number;
  /** Move over the last five sessions. */
  move5dPct: number;
  regime: string;
}

export function renderEvidence(e: Evidence): string {
  const lines = [
    `Company: ${e.symbol}`,
    `Move today: ${(e.movePct * 100).toFixed(2)}%`,
    `Move over 5 sessions: ${(e.move5dPct * 100).toFixed(2)}%`,
    `Overall market: ${e.regime}`,
    '',
    'Headlines:',
    ...e.headlines.map(
      (h, i) => `${String(i)}. [${h.publishedAt.slice(0, 10)}] ${h.title} — ${h.publisher}`,
    ),
  ];
  return lines.join('\n');
}

type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Shared call path.
 *
 * Both sides of the debate record their own spend and log their own cost, so
 * the dashboard can show what the debate cost per candidate rather than one
 * undifferentiated total.
 */
async function call<T>(
  agent: string,
  prompt: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  deps: ThesisDeps,
  model: ModelId,
  kind: 'discretionary' | 'entry',
): Promise<Outcome<T>> {
  if (!deps.budget.allows(kind)) {
    return { ok: false, reason: `paused until ${String(deps.budget.pausedUntil())} (plan usage limit)` };
  }
  let result;
  try {
    result = await (deps.ask ?? askClaude)(prompt, { model, agent });
  } catch (err) {
    const msg = err instanceof ClaudeError ? `${err.code}: ${err.message}` : String(err);
    // A plan usage limit is not a bad call, it is the ceiling arriving. Park
    // every agent until it lifts rather than burning retries against it.
    if (err instanceof ClaudeError && err.code === 'USAGE_LIMIT') {
      deps.budget.pause(Date.now() + (err.retryAfterMs ?? 900_000), err.message);
    }
    deps.log.error(agent, msg);
    deps.budget.record({
      agent, model, tokensIn: Math.ceil(prompt.length / 4), tokensOut: 0,
      costUsd: '0', latencyMs: 0, ok: false, error: msg,
    });
    return { ok: false, reason: msg };
  }

  deps.budget.record({
    agent, model: result.model,
    tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    costUsd: result.costUsd, latencyMs: result.latencyMs,
    ok: true, promptHash: result.promptHash,
  });
  deps.log.llm(agent, {
    model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    costUsd: result.costUsd, latencyMs: result.latencyMs,
  });

  const parsed = parseModelJson(result.text, schema);
  if (!parsed.ok) {
    deps.log.warn(agent, `unparseable reply: ${parsed.error}`);
    return { ok: false, reason: parsed.error };
  }
  return { ok: true, value: parsed.value };
}

export function proposeThesis(e: Evidence, deps: ThesisDeps): Promise<Outcome<Thesis>> {
  return call(
    'analyst', ANALYST_PROMPT + renderEvidence(e), ThesisSchema, deps,
    deps.analystModel ?? 'haiku', 'entry',
  );
}

export function challengeThesis(
  e: Evidence,
  t: Thesis,
  deps: ThesisDeps,
): Promise<Outcome<Challenge>> {
  const body = [
    renderEvidence(e),
    '',
    'The proposed trade:',
    `Direction: ${t.direction}   Conviction: ${String(t.conviction)}   Horizon: ${String(t.horizonDays)}d`,
    `Thesis: ${t.thesis}`,
    '',
    'Claims to check:',
    ...t.claims.map((c, i) => `${String(i)}. ${c}`),
  ].join('\n');
  // Sonnet by default: this is the step that stops a bad trade, and it is the
  // last one before money moves.
  return call(
    'challenger', CHALLENGER_PROMPT + body, ChallengeSchema, deps,
    deps.challengerModel ?? 'sonnet', 'entry',
  );
}

// ── Turning a debate into a decision ────────────────────────────────────────

export interface DebateResult {
  trade: boolean;
  direction: 'long' | 'short' | null;
  /** 0-1. Scales the position. */
  strength: number;
  reason: string;
}

export interface DebateRule {
  minConviction: number;
  /** Fraction of claims that must be SUPPORTED. */
  minSupportedRatio: number;
  /** Challenger confidence below which even a PROCEED is not acted on. */
  minChallengerConfidence: number;
}

export const DEFAULT_DEBATE: DebateRule = {
  minConviction: 60,
  minSupportedRatio: 0.6,
  minChallengerConfidence: 55,
};

/**
 * The debate's outcome, decided by arithmetic rather than a third model call.
 *
 * Both sides have spoken; asking a third model to referee would add cost and a
 * new way to be wrong without adding information. The rules are explicit so a
 * rejected trade can be explained without re-reading two paragraphs of prose.
 */
export function resolveDebate(
  t: Thesis,
  c: Challenge,
  rule: DebateRule = DEFAULT_DEBATE,
): DebateResult {
  const no = (reason: string): DebateResult => ({ trade: false, direction: null, strength: 0, reason });

  if (t.direction === 'NONE') return no('the analyst declined to take a side');
  if (c.verdict === 'REJECT') return no(`challenger rejected: ${c.oneLine}`);

  const contradicted = c.claimVerdicts.filter((v) => v.verdict === 'CONTRADICTED');
  if (contradicted.length > 0) {
    // A contradicted claim is not a weak trade, it is a wrong one. No amount of
    // conviction elsewhere in the thesis repairs it.
    return no(`a claim is contradicted by the source: ${contradicted[0]!.claim.slice(0, 90)}`);
  }

  const supported = c.claimVerdicts.filter((v) => v.verdict === 'SUPPORTED').length;
  const ratio = c.claimVerdicts.length === 0 ? 0 : supported / c.claimVerdicts.length;
  if (ratio < rule.minSupportedRatio) {
    return no(
      `only ${supported}/${String(c.claimVerdicts.length)} claims are supported by the headlines`,
    );
  }

  if (t.conviction < rule.minConviction) {
    return no(`conviction ${String(t.conviction)} below ${String(rule.minConviction)}`);
  }
  if (c.confidence < rule.minChallengerConfidence) {
    return no(`challenger is only ${String(c.confidence)}% confident in its own verdict`);
  }

  // Strength blends both sides: a thesis the challenger only grudgingly allowed
  // through should take a smaller position than one it endorsed.
  const caution = c.verdict === 'PROCEED_WITH_CAUTION' ? 0.6 : 1;
  const strength = Math.min(1, (t.conviction / 100) * ratio * caution);

  return {
    trade: true,
    direction: t.direction === 'LONG' ? 'long' : 'short',
    strength,
    reason: `${String(supported)}/${String(c.claimVerdicts.length)} claims supported, ${c.verdict}`,
  };
}

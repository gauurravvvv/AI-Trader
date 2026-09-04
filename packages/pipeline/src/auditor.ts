import { z } from 'zod';
import { askClaude, parseModelJson, ClaudeError, type ModelId, type AskFn } from '@aegis/claude';
import type { BudgetGovernor } from '@aegis/budget';
import type { Logger } from '@aegis/logger';
import type { VerifiedEarningsRead } from '@aegis/alpha';
import type { SueResult } from '@aegis/alpha';

export const AuditSchema = z.object({
  dataQuality: z.number().min(0).max(20),
  methodology: z.number().min(0).max(20),
  signalConsistency: z.number().min(0).max(20),
  riskCoverage: z.number().min(0).max(20),
  reasoningTransparency: z.number().min(0).max(20),
  redFlags: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  strengths: z.array(z.string()).default([]),
  verdict: z.enum(['PROCEED', 'PROCEED_WITH_CAUTION', 'REJECT']),
  oneLineJudgement: z.string(),
});

export type Audit = z.infer<typeof AuditSchema>;

export type AuditTier = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW';

export interface AuditResult extends Audit {
  total: number;
  tier: AuditTier;
  passesFloor: boolean;
  costUsd: string;
  model: ModelId;
}

export function tierFor(total: number): AuditTier {
  if (total >= 85) return 'VERY_HIGH';
  if (total >= 70) return 'HIGH';
  if (total >= 55) return 'MEDIUM';
  if (total >= 40) return 'LOW';
  return 'VERY_LOW';
}

/**
 * The Auditor scores the REASONING, not the stock.
 *
 * It is deliberately given no portfolio, no P&L, and no information about how
 * the month is going. Knowing we are down would give it a reason to be lenient,
 * and knowing we are up would give it a reason to be cautious — neither is
 * evidence about whether this particular argument holds.
 */
function buildPrompt(
  symbol: string,
  read: VerifiedEarningsRead,
  score: SueResult,
  numericSue: number | null,
): string {
  return `You are auditing an automated investment analysis. Score the QUALITY OF THE REASONING, not whether you like the stock. You are not being asked whether ${symbol} will go up.

THE ANALYSIS UNDER REVIEW
Symbol: ${symbol}
Standardised earnings surprise from consensus data: ${numericSue === null ? 'UNAVAILABLE' : `${numericSue.toFixed(2)} sigma`}
Composite score: ${score.sue} (gate is 1.50, ${score.passesGate ? 'PASSED' : 'FAILED'})

What the model read from the filing text:
  guidance delta      ${read.guidanceDelta}${read.guidanceEvidence ? ` — "${read.guidanceEvidence.slice(0, 200)}"` : ''}
  momentum shift      ${String(read.momentumShift)}
  language tone       ${String(read.languageTone)}
  hedging density     ${String(read.hedgingDensity)}
  self-confidence     ${String(read.confidence)}/100
  risk flags          ${read.riskFlags.length === 0 ? 'none' : read.riskFlags.join(' | ')}
  data gaps           ${read.dataGaps.length === 0 ? 'none' : read.dataGaps.map((g) => `${g.field}: ${g.reason}`).join(' | ')}
  verbatim quotes     ${read.keyQuotes.length === 0 ? 'none supplied' : read.keyQuotes.map((q) => `"${q.quote.slice(0, 120)}"`).join(' | ')}
  DISCARDED as not verbatim: ${read.fabricatedQuotes.length === 0 ? 'none' : read.fabricatedQuotes.join(' | ')}
  one-line rationale  ${read.oneLineWhy}

Score penalties already applied: ${score.penalties.length === 0 ? 'none' : score.penalties.join(' | ')}

SCORE FIVE DIMENSIONS, 0-20 EACH
- dataQuality: is the underlying evidence real, recent and complete? Discarded quotes and data gaps count heavily against this.
- methodology: is combining a standardised numeric surprise with a textual read defensible here? Is the numeric term present or missing?
- signalConsistency: do the numeric surprise, the guidance, the tone and the momentum point the same way? Contradiction is not automatically bad, but unexplained contradiction is.
- riskCoverage: were real downside risks identified, or is this one-sided?
- reasoningTransparency: does the conclusion follow from the stated evidence, with limitations acknowledged?

Then:
- redFlags: anything that should stop this trade outright. Fabricated quotes belong here.
- verdict: PROCEED, PROCEED_WITH_CAUTION, or REJECT.

Be strict. A high score is a claim that someone should risk money on this reasoning.

Reply with ONLY JSON, no markdown fences:
{"dataQuality":0-20,"methodology":0-20,"signalConsistency":0-20,"riskCoverage":0-20,"reasoningTransparency":0-20,"redFlags":["..."],"warnings":["..."],"strengths":["..."],"verdict":"PROCEED|PROCEED_WITH_CAUTION|REJECT","oneLineJudgement":"..."}`;
}

export interface AuditDeps {
  budget: BudgetGovernor;
  log: Logger;
  floor?: number;
  /** Defaults to the real Claude CLI. Overridden in tests. */
  ask?: AskFn;
}

export type AuditOutcome =
  | { ok: true; audit: AuditResult }
  | { ok: false; reason: string };

/**
 * Fails CLOSED. A failed audit is never treated as a pass — if we cannot
 * establish that the reasoning is sound, we do not trade on it.
 */
export async function auditDecision(
  symbol: string,
  read: VerifiedEarningsRead,
  score: SueResult,
  numericSue: number | null,
  deps: AuditDeps,
): Promise<AuditOutcome> {
  const agent = 'thesis-auditor';
  const floor = deps.floor ?? 70;

  if (!deps.budget.allows('entry')) {
    return { ok: false, reason: `budget tier ${deps.budget.tier()} blocks audit` };
  }

  let result;
  try {
    result = await (deps.ask ?? askClaude)(buildPrompt(symbol, read, score, numericSue), {
      model: 'sonnet',
      agent,
    });
  } catch (err) {
    const msg = err instanceof ClaudeError ? `${err.code}: ${err.message}` : String(err);
    // A plan usage limit is not a bad call, it is the ceiling arriving. Park
    // every agent until it lifts rather than burning retries against it.
    if (err instanceof ClaudeError && err.code === 'USAGE_LIMIT') {
      deps.budget.pause(Date.now() + (err.retryAfterMs ?? 900_000), err.message);
    }
    deps.log.error(agent, msg);
    return { ok: false, reason: msg };
  }

  deps.log.llm(agent, result);
  deps.budget.record({
    agent,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    ok: true,
    promptHash: result.promptHash,
  });

  const parsed = parseModelJson(result.text, AuditSchema);
  if (!parsed.ok) {
    deps.log.error(agent, `audit parse failed: ${parsed.error}`);
    return { ok: false, reason: `unparseable audit: ${parsed.error}` };
  }

  const a = parsed.value;
  const total =
    a.dataQuality + a.methodology + a.signalConsistency + a.riskCoverage + a.reasoningTransparency;
  const tier = tierFor(total);

  // A red flag or an explicit REJECT overrides the arithmetic. The score is a
  // summary; the flag is a specific objection, and a specific objection beats
  // a summary.
  const passesFloor = total >= floor && a.redFlags.length === 0 && a.verdict !== 'REJECT';

  return {
    ok: true,
    audit: { ...a, total, tier, passesFloor, costUsd: result.costUsd, model: result.model },
  };
}

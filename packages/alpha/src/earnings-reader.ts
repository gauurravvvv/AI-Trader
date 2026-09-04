import { z } from 'zod';
import { askClaude, parseModelJson, ClaudeError, type ModelId, type AskFn } from '@aegis/claude';
import type { BudgetGovernor } from '@aegis/budget';
import type { Logger } from '@aegis/logger';

/**
 * What the FILING can tell us. Deliberately contains no beat/miss field: the
 * first live run proved a press release never states consensus, so asking the
 * model for a surprise direction only invited it to guess or, correctly, to
 * answer UNCLEAR. The numeric surprise comes from consensus data instead; this
 * schema captures the language, which is the part no data feed has.
 */
export const EarningsReadSchema = z.object({
  guidanceDelta: z.enum(['RAISED', 'MAINTAINED', 'LOWERED', 'WITHDRAWN', 'NONE']),
  guidanceEvidence: z.string().default(''),
  languageTone: z.number().min(-1).max(1),
  hedgingDensity: z.number().min(0).max(1),
  momentumShift: z.number().min(-1).max(1),
  riskFlags: z.array(z.string()).default([]),
  keyQuotes: z.array(z.object({ quote: z.string(), why: z.string() })).max(3),
  oneLineWhy: z.string(),
  confidence: z.number().min(0).max(100),
  dataGaps: z.array(z.object({ field: z.string(), reason: z.string() })),
});

export type EarningsRead = z.infer<typeof EarningsReadSchema>;

export interface VerifiedEarningsRead extends EarningsRead {
  /** Quotes that did not appear verbatim in the filing, and were discarded. */
  fabricatedQuotes: string[];
  model: ModelId;
  costUsd: string;
  latencyMs: number;
}

const PROMPT = `You are reading a company's earnings press release, filed with the SEC as Exhibit 99.1 to an 8-K.

IMPORTANT: this document states what the company earned. It does NOT state what analysts expected. Do not try to infer a beat or a miss — that comparison is made elsewhere from consensus data. Your job is to read the LANGUAGE, which is the part no data feed captures.

Extract only what the document actually says. If something is not stated, record it in dataGaps rather than estimating it.

Reply with ONLY a JSON object, no prose and no markdown fences:

{
  "guidanceDelta": "RAISED" | "MAINTAINED" | "LOWERED" | "WITHDRAWN" | "NONE",
  "guidanceEvidence": "the sentence that shows it, or empty string",
  "languageTone": -1.0 to 1.0,
  "hedgingDensity": 0.0 to 1.0,
  "momentumShift": -1.0 to 1.0,
  "riskFlags": ["..."],
  "keyQuotes": [{ "quote": "...", "why": "..." }],
  "oneLineWhy": "...",
  "confidence": 0-100,
  "dataGaps": [{ "field": "...", "reason": "..." }]
}

Field meanings:
- guidanceDelta: what the release says about FORWARD guidance versus the prior outlook. NONE when no forward guidance is given; MAINTAINED only when explicitly reaffirmed. If guidance is present but you cannot tell whether it moved, use NONE and note it in dataGaps.
- guidanceEvidence: the sentence justifying guidanceDelta, verbatim.
- languageTone: management's tone. -1 defensive or apologetic, 0 neutral, +1 confident.
- hedgingDensity: how much conditional and qualifying language the release carries ("subject to", "we believe", "could", "assuming"). Rising hedging is a documented negative signal even alongside good numbers.
- momentumShift: is the business accelerating or decelerating on the company's OWN stated trajectory — this quarter's growth rate versus the prior quarter's, sequential trends, segment commentary. -1 sharp deceleration, 0 steady, +1 sharp acceleration. About the company's own numbers over time, not analyst expectations.
- riskFlags: specific concerns the text raises — charges, impairments, restatements, litigation, executive departures, covenant or liquidity language, customer concentration.
- keyQuotes: up to 3 short quotes, copied EXACTLY AND VERBATIM from the document. Do not paraphrase, do not repair grammar, do not join fragments. Any quote that is not a character-for-character substring of the document will be discarded and counted against this read's reliability.
- confidence: how confident you are in this read given what the document contains.

FILING TEXT:
`;

export interface ReadOptions {
  model?: ModelId;
  timeoutMs?: number;
}

export interface ReaderDeps {
  budget: BudgetGovernor;
  log: Logger;
  agentName?: string;
  /** Defaults to the real Claude CLI. Overridden in tests. */
  ask?: AskFn;
}

export type ReadOutcome =
  | { ok: true; read: VerifiedEarningsRead }
  | { ok: false; reason: string; stage: 'budget' | 'call' | 'parse' };

/**
 * Verify each quote appears verbatim in the source.
 *
 * A model that invents a supporting quote has invented the support. We cannot
 * check the reasoning directly, but we can check the one part of it that is
 * mechanically checkable — and a read that fabricates evidence should not be
 * trusted on the parts we cannot verify either.
 */
export function verifyQuotes(
  read: EarningsRead,
  sourceText: string,
): { kept: EarningsRead['keyQuotes']; fabricated: string[] } {
  const haystack = normalise(sourceText);
  const kept: EarningsRead['keyQuotes'] = [];
  const fabricated: string[] = [];
  for (const q of read.keyQuotes) {
    if (q.quote.trim().length >= 8 && haystack.includes(normalise(q.quote))) kept.push(q);
    else fabricated.push(q.quote);
  }
  return { kept, fabricated };
}

/** Whitespace and typographic quotes vary between the filing and the model's echo. */
function normalise(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Reads one earnings filing into a structured signal.
 *
 * This is the one expensive call in the pipeline and the only place the model's
 * actual skill — reading long text consistently — is the edge, rather than a
 * price forecast wearing a costume.
 */
export async function readEarnings(
  filingText: string,
  deps: ReaderDeps,
  opts: ReadOptions = {},
): Promise<ReadOutcome> {
  const agent = deps.agentName ?? 'earnings-reader';
  const model: ModelId = opts.model ?? 'sonnet';

  if (!deps.budget.allows('entry')) {
    deps.log.warn(agent, `budget tier ${deps.budget.tier()} blocks entry reads`);
    return { ok: false, reason: `budget tier ${deps.budget.tier()}`, stage: 'budget' };
  }

  let result;
  try {
    result = await (deps.ask ?? askClaude)(PROMPT + filingText, {
      model,
      agent,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (err) {
    const msg = err instanceof ClaudeError ? `${err.code}: ${err.message}` : String(err);
    // A plan usage limit is not a bad call, it is the ceiling arriving. Park
    // every agent until it lifts rather than burning retries against it.
    if (err instanceof ClaudeError && err.code === 'USAGE_LIMIT') {
      deps.budget.pause(Date.now() + (err.retryAfterMs ?? 900_000), err.message);
    }
    deps.log.error(agent, msg);
    // A failed call still consumed input tokens; charge for it.
    deps.budget.record({
      agent,
      model,
      tokensIn: Math.ceil((PROMPT.length + filingText.length) / 4),
      tokensOut: 0,
      costUsd: '0',
      latencyMs: opts.timeoutMs ?? 0,
      ok: false,
      error: msg,
    });
    return { ok: false, reason: msg, stage: 'call' };
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

  const parsed = parseModelJson(result.text, EarningsReadSchema);
  if (!parsed.ok) {
    deps.log.error(agent, `parse failed at ${parsed.stage}: ${parsed.error}`);
    return { ok: false, reason: parsed.error, stage: 'parse' };
  }

  const { kept, fabricated } = verifyQuotes(parsed.value, filingText);
  if (fabricated.length > 0) {
    deps.log.warn(agent, `${String(fabricated.length)} quote(s) not verbatim — discarded`);
  }

  return {
    ok: true,
    read: {
      ...parsed.value,
      keyQuotes: kept,
      fabricatedQuotes: fabricated,
      model: result.model,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    },
  };
}

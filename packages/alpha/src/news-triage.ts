import { z } from 'zod';
import { askClaude, parseModelJson, ClaudeError, type ModelId, type AskFn } from '@aegis/claude';
import type { BudgetGovernor } from '@aegis/budget';
import type { Logger } from '@aegis/logger';

export const TriageItemSchema = z.object({
  /** Index into the batch as it was sent. */
  i: z.number().int().min(0),
  /** 0 = noise, 100 = repriced the company. */
  materiality: z.number().min(0).max(100),
  /** Sign and strength of the expected price effect. */
  direction: z.number().min(-1).max(1),
  category: z.enum([
    'EARNINGS',
    'GUIDANCE',
    'MA',
    'REGULATORY',
    'PRODUCT',
    'LEADERSHIP',
    'LEGAL',
    'MACRO',
    'ANALYST',
    'OPINION',
    'NOISE',
  ]),
  why: z.string().max(200),
});

export const TriageSchema = z.object({ items: z.array(TriageItemSchema) });

export type TriageItem = z.infer<typeof TriageItemSchema>;

/**
 * Triage is a filter, not a thesis.
 *
 * The prompt deliberately pushes towards NOISE. A headline is one sentence
 * written to be clicked; a model asked "is this significant?" will find
 * significance in almost anything, and every false positive downstream costs a
 * sonnet call. Recall matters less than precision here: a genuinely material
 * event generates many headlines, so missing one is survivable, while promoting
 * an opinion column is not.
 */
const PROMPT = `You are triaging financial news headlines. For each headline decide whether it
could plausibly move the stock, and in which direction.

Rules:
- Default to NOISE with materiality below 20. Most headlines are recycled
  commentary, listicles, or price recaps that report a move rather than cause one.
- "Stock rises 4%" is NOISE: it reports the move, it does not explain it.
- Opinion, "should you buy", "3 reasons", and analyst price-target changes are
  OPINION or ANALYST and rarely exceed materiality 35.
- Reserve materiality above 70 for facts that change the cash flows or the risk:
  earnings, guidance, M&A, regulatory action, a major contract, litigation
  outcomes, or leadership departure.
- direction is the expected price effect: -1 strongly negative, 0 neutral,
  +1 strongly positive. A material fact with an unclear sign gets 0.
- Judge only the headline. Do not infer facts it does not state.

Return ONLY JSON, no prose and no code fences:
{"items":[{"i":0,"materiality":0-100,"direction":-1..1,"category":"...","why":"under 20 words"}]}

Include exactly one object per headline, with "i" matching the number shown.

Headlines:
`;

export interface TriageDeps {
  budget: BudgetGovernor;
  log: Logger;
  ask?: AskFn;
  agentName?: string;
}

export type TriageOutcome =
  | { ok: true; items: TriageItem[] }
  | { ok: false; reason: string; stage: 'budget' | 'call' | 'parse' };

export function buildBatch(titles: string[]): string {
  return titles.map((t, i) => `${String(i)}. ${t.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
}

export async function triageNews(
  titles: string[],
  deps: TriageDeps,
  opts: { model?: ModelId; timeoutMs?: number } = {},
): Promise<TriageOutcome> {
  const agent = deps.agentName ?? 'news-triage';
  // Triage is research, so it is the first thing the Governor switches off.
  if (!deps.budget.allows('discretionary')) {
    return { ok: false, reason: `budget tier ${deps.budget.tier()}`, stage: 'budget' };
  }
  if (titles.length === 0) return { ok: true, items: [] };

  // Haiku on purpose: this is a filter run over many items, and the expensive
  // reasoning belongs downstream on the few that survive it.
  const model: ModelId = opts.model ?? 'haiku';
  const prompt = PROMPT + buildBatch(titles);

  let result;
  try {
    result = await (deps.ask ?? askClaude)(prompt, {
      model,
      agent,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (err) {
    const msg = err instanceof ClaudeError ? `${err.code}: ${err.message}` : String(err);
    deps.log.error(agent, msg);
    deps.budget.record({
      agent, model,
      tokensIn: Math.ceil(prompt.length / 4), tokensOut: 0,
      costUsd: '0', latencyMs: opts.timeoutMs ?? 0, ok: false, error: msg,
    });
    return { ok: false, reason: msg, stage: 'call' };
  }

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
  deps.log.llm(agent, {
    model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    costUsd: result.costUsd, latencyMs: result.latencyMs,
  });

  const parsed = parseModelJson(result.text, TriageSchema);
  if (!parsed.ok) {
    deps.log.error(agent, `triage parse failed: ${parsed.error}`);
    return { ok: false, reason: parsed.error, stage: 'parse' };
  }

  // An index the batch never contained is a hallucinated row, not a rating.
  const items = parsed.value.items.filter((it) => it.i < titles.length);
  const dropped = parsed.value.items.length - items.length;
  if (dropped > 0) deps.log.warn(agent, `dropped ${String(dropped)} rating(s) for headlines not sent`);
  return { ok: true, items: dedupeByIndex(items) };
}

/** One rating per headline. A repeated index means the model lost its place. */
export function dedupeByIndex(items: TriageItem[]): TriageItem[] {
  const byIndex = new Map<number, TriageItem>();
  for (const it of items) if (!byIndex.has(it.i)) byIndex.set(it.i, it);
  return [...byIndex.values()].sort((a, b) => a.i - b.i);
}

/**
 * Materiality alone is not tradeable: a certain-but-neutral fact moves nothing.
 * Weighting by |direction| keeps "material, sign unclear" out of the queue.
 */
export function newsScore(it: TriageItem): number {
  return (it.materiality / 100) * Math.abs(it.direction);
}

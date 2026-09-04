import { z } from 'zod';
import { BaseAgent } from '@aegis/agents';
import { askClaude, parseModelJson, ClaudeError, type AskFn } from '@aegis/claude';
import type { Db } from '@aegis/db';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { PipelineDeps } from './agents.js';

/**
 * How a trade turned out once the market's own move is removed.
 *
 * The four-way split exists because raw return cannot distinguish skill from
 * drift. A +8% trade in a +12% market is not a win; scoring it as one teaches
 * the system to repeat whatever it did in a bull market. Equally, a -3% trade
 * in a -10% market was a good decision that lost money, and punishing it
 * teaches the system to stop trading exactly when it is adding the most value.
 */
export type Verdict =
  | 'ALPHA_WIN'        // beat the market
  | 'ALPHA_LOSS'       // lost to the market
  | 'MARKET_CARRIED'   // made money, but less than the index
  | 'MARKET_MASKED';   // lost money, but less than the index

export interface Outcome {
  rawReturn: number;
  benchmarkReturn: number;
  alphaReturn: number;
  verdict: Verdict;
}

export function classify(rawReturn: number, benchmarkReturn: number): Outcome {
  const alphaReturn = rawReturn - benchmarkReturn;
  let verdict: Verdict;
  if (alphaReturn > 0) verdict = rawReturn >= 0 ? 'ALPHA_WIN' : 'MARKET_MASKED';
  else verdict = rawReturn >= 0 ? 'MARKET_CARRIED' : 'ALPHA_LOSS';
  return { rawReturn, benchmarkReturn, alphaReturn, verdict };
}

export const LessonSchema = z.object({
  /** A short, reusable tag. Grouping is the whole point of storing these. */
  category: z.string().min(2).max(40),
  /** One sentence, actionable, about the decision rather than the outcome. */
  lesson: z.string().min(10).max(400),
  confidence: z.number().min(0).max(100),
});

export type Lesson = z.infer<typeof LessonSchema>;

const PROMPT = `You are reviewing one closed paper trade to extract a reusable lesson.

You are judging the DECISION, not the outcome. A good decision can lose money and
a bad one can make it. Say what, if anything, should be done differently next time
given only what was knowable at entry.

Rules:
- The alpha return is what matters. A trade that made money while the market made
  more is not a success.
- If the decision looks sound and the result was noise, say so plainly. "Nothing
  to change, this was variance" is a valid and useful lesson.
- Do not invent facts about the company. You have only what is below.
- category is a short reusable tag, lower-case, like "entered-after-the-move",
  "held-through-guidance-cut", "sizing-too-large", "sound-decision-noisy-outcome".

Return ONLY JSON, no prose and no code fences:
{"category":"...","lesson":"one sentence under 40 words","confidence":0-100}

The trade:
`;

export interface ReflectorDeps extends PipelineDeps {
  prices: YahooPriceSource;
  /** Benchmark for the alpha adjustment. */
  benchmarkSymbol?: string;
  ask?: AskFn;
}

interface ClosedRow {
  id: number;
  symbol: string;
  venue: string;
  avg_cost: string;
  realised_pnl: string;
  opened_at: string | null;
  closed_at: string;
  decision_id: number | null;
  rationale: string | null;
}

/**
 * Reads closed trades and records what to do differently.
 *
 * Runs at most a few calls per tick and only on trades it has not already
 * reflected on, so a busy week does not become a budget event. Gated at the
 * discretionary tier: understanding the past is the first thing to drop when
 * credit is short.
 */
export class ReflectorAgent extends BaseAgent {
  constructor(private readonly r: ReflectorDeps, private readonly perTick = 3) {
    super('reflector', { intervalMs: 30 * 60 * 1000 }, r);
  }

  override shouldRun(): boolean {
    return this.budget.allows('discretionary') && this.unreflected(1).length > 0;
  }

  /** Closed positions with no lesson yet. */
  private unreflected(limit: number): ClosedRow[] {
    return this.db
      .prepare(
        `SELECT p.id, p.symbol, p.venue, p.avg_cost, p.realised_pnl,
                p.opened_at, p.closed_at, d.id AS decision_id, d.rationale
           FROM positions p
           LEFT JOIN decisions d
             ON d.symbol = p.symbol AND d.venue = p.venue AND d.side = 'buy'
                AND d.status = 'EXECUTED'
           WHERE p.closed_at IS NOT NULL
             AND (d.id IS NULL OR d.id NOT IN (SELECT decision_id FROM lessons WHERE decision_id IS NOT NULL))
           GROUP BY p.id
           ORDER BY p.closed_at DESC
           LIMIT ?`,
      )
      .all(limit) as ClosedRow[];
  }

  async execute(): Promise<void> {
    for (const row of this.unreflected(this.perTick)) {
      const outcome = await this.outcomeFor(row);
      if (outcome === null) {
        this.log.warn(this.name, `${row.symbol}: no benchmark history, cannot judge alpha`);
        continue;
      }

      this.log.event(
        this.name,
        `${row.symbol}  raw ${pct(outcome.rawReturn)}  bench ${pct(outcome.benchmarkReturn)}  ` +
          `alpha ${pct(outcome.alphaReturn)}  → ${outcome.verdict}`,
      );

      const lesson = await this.askForLesson(row, outcome);
      if (lesson === null) continue;

      this.db
        .prepare(
          `INSERT OR IGNORE INTO lessons
             (symbol, venue, decision_id, source, raw_return, benchmark_return,
              alpha_return, verdict, category, lesson, confidence)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.symbol,
          row.venue,
          row.decision_id,
          row.rationale?.startsWith('news:') === true ? 'news' : 'earnings',
          outcome.rawReturn,
          outcome.benchmarkReturn,
          outcome.alphaReturn,
          outcome.verdict,
          lesson.category,
          lesson.lesson,
          lesson.confidence,
        );
      this.log.ok(this.name, `${row.symbol}  [${lesson.category}] ${lesson.lesson.slice(0, 90)}`);
    }
  }

  /** Trade return minus the benchmark's move over the same window. */
  private async outcomeFor(row: ClosedRow): Promise<Outcome | null> {
    const cost = Number(row.avg_cost);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    // realised_pnl is currency; convert to a return on the entry notional.
    const rawReturn = Number(row.realised_pnl) / cost;

    const bench = await this.benchmarkMove(row.opened_at, row.closed_at);
    if (bench === null) return null;
    return classify(rawReturn, bench);
  }

  private async benchmarkMove(openedAt: string | null, closedAt: string): Promise<number | null> {
    if (openedAt === null) return null;
    const days = Math.max(
      2,
      Math.ceil((Date.parse(closedAt) - Date.parse(openedAt)) / 86_400_000) + 5,
    );
    const bars = await this.r.prices.bars(this.r.benchmarkSymbol ?? 'SPY', days);
    if (bars.length < 2) return null;
    const first = bars.at(0)?.c ?? 0;
    const last = bars.at(-1)?.c ?? 0;
    return first > 0 ? (last - first) / first : null;
  }

  private async askForLesson(row: ClosedRow, o: Outcome): Promise<Lesson | null> {
    const body = [
      `Symbol:            ${row.symbol}`,
      `Entry price:       ${row.avg_cost}`,
      `Held:              ${row.opened_at ?? '?'} to ${row.closed_at}`,
      `Raw return:        ${pct(o.rawReturn)}`,
      `Benchmark return:  ${pct(o.benchmarkReturn)}`,
      `Alpha return:      ${pct(o.alphaReturn)}`,
      `Verdict:           ${o.verdict}`,
      `Reason for entry:  ${row.rationale ?? 'not recorded'}`,
    ].join('\n');

    let result;
    try {
      result = await (this.r.ask ?? askClaude)(PROMPT + body, {
        model: 'haiku',
        agent: this.name,
      });
    } catch (err) {
      const msg = err instanceof ClaudeError ? `${err.code}: ${err.message}` : String(err);
      this.log.error(this.name, msg);
      return null;
    }

    this.budget.record({
      agent: this.name,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      ok: true,
      promptHash: result.promptHash,
    });
    this.log.llm(this.name, {
      model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
      costUsd: result.costUsd, latencyMs: result.latencyMs,
    });

    const parsed = parseModelJson(result.text, LessonSchema);
    if (!parsed.ok) {
      this.log.warn(this.name, `${row.symbol}: unparseable lesson (${parsed.error})`);
      return null;
    }
    return parsed.value;
  }
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}

export interface LessonGroup {
  category: string;
  count: number;
  meanAlpha: number;
  examples: string[];
}

/**
 * Lessons grouped by category, worst mean alpha first.
 *
 * One lesson is an anecdote. The categories that recur, and cost the most, are
 * the ones worth changing a threshold over.
 */
export function groupLessons(db: Db, limit = 10): LessonGroup[] {
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) n, AVG(alpha_return) a
         FROM lessons WHERE category IS NOT NULL
         GROUP BY category ORDER BY a ASC LIMIT ?`,
    )
    .all(limit) as { category: string; n: number; a: number }[];

  return rows.map((r) => ({
    category: r.category,
    count: r.n,
    meanAlpha: r.a,
    examples: (
      db
        .prepare('SELECT lesson FROM lessons WHERE category = ? ORDER BY id DESC LIMIT 2')
        .all(r.category) as { lesson: string }[]
    ).map((x) => x.lesson),
  }));
}

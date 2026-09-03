import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';

export type Tier = 'NORMAL' | 'CONSERVE' | 'ESSENTIAL' | 'RULES_ONLY';
export type CallKind = 'discretionary' | 'entry' | 'position_protecting';

export interface LlmCallRecord {
  agent: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
  promptHash?: string;
}

const THRESHOLDS: readonly (readonly [number, Tier])[] = [
  [0.95, 'RULES_ONLY'],
  [0.85, 'ESSENTIAL'],
  [0.7, 'CONSERVE'],
];

/**
 * Which call kinds each tier still permits. The invariant that matters:
 * RULES_ONLY permits nothing, and the system must remain able to exit and
 * protect positions with zero LLM involvement. Running out of credit must never
 * leave an open position unmanaged.
 */
const ALLOWED: Record<Tier, ReadonlySet<CallKind>> = {
  NORMAL: new Set(['discretionary', 'entry', 'position_protecting']),
  CONSERVE: new Set(['entry', 'position_protecting']),
  ESSENTIAL: new Set(['position_protecting']),
  RULES_ONLY: new Set(),
};

export class BudgetGovernor {
  constructor(
    private readonly db: Db,
    private readonly budgetUsd: number,
    private readonly cycleStart: string,
  ) {
    this.db
      .prepare('INSERT OR IGNORE INTO budget_cycles (cycle_start, budget_usd) VALUES (?, ?)')
      .run(cycleStart, String(budgetUsd));
  }

  record(call: LlmCallRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO llm_calls
             (agent, model, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, prompt_hash)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          call.agent,
          call.model,
          call.tokensIn,
          call.tokensOut,
          call.costUsd,
          call.latencyMs,
          call.ok ? 1 : 0,
          call.error ?? null,
          call.promptHash ?? null,
        );

      const next = new Decimal(this.spent()).plus(call.costUsd).toFixed(6);
      this.db
        .prepare(
          `UPDATE budget_cycles SET spent_usd = ?, tier = ?, updated_at = datetime('now')
           WHERE cycle_start = ?`,
        )
        .run(next, this.tierFor(next), this.cycleStart);
    })();
  }

  spent(): string {
    const row = this.db
      .prepare('SELECT spent_usd FROM budget_cycles WHERE cycle_start = ?')
      .get(this.cycleStart) as { spent_usd: string } | undefined;
    return row?.spent_usd ?? '0';
  }

  remaining(): string {
    return Decimal.max(0, new Decimal(this.budgetUsd).minus(this.spent())).toFixed(6);
  }

  fraction(): number {
    return new Decimal(this.spent()).div(this.budgetUsd).toNumber();
  }

  private tierFor(spent: string): Tier {
    const f = new Decimal(spent).div(this.budgetUsd).toNumber();
    for (const [threshold, tier] of THRESHOLDS) if (f >= threshold) return tier;
    return 'NORMAL';
  }

  tier(): Tier {
    return this.tierFor(this.spent());
  }

  allows(kind: CallKind): boolean {
    return ALLOWED[this.tier()].has(kind);
  }
}

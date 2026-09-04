import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';
import type { BudgetGovernor } from '@aegis/budget';
import type { NotifyLike } from './agents.js';
import { closedTrades, summarise } from './evaluator.js';

export interface DaySummary {
  day: string;
  decisions: number;
  approved: number;
  rejected: number;
  ordersFilled: number;
  realisedPnl: string;
  feesPaid: string;
  openPositions: number;
  llmCalls: number;
  llmCost: string;
  topRejectReason: string | null;
}

/**
 * A day's worth of activity, read straight from the ledger and the decision log.
 *
 * Deliberately arithmetic rather than a model call: a summary that costs money
 * to produce is the first thing the Budget Governor would switch off, and a
 * quiet day is exactly when you most want to know the system is still alive.
 */
export function collectSummary(db: Db, venue: string, day: string): DaySummary {
  const one = <T>(sql: string, ...args: unknown[]): T =>
    db.prepare(sql).get(...args) as T;

  const d = one<{ n: number; ap: number; rj: number }>(
    `SELECT COUNT(*) n,
            SUM(CASE WHEN status IN ('APPROVED','EXECUTED') THEN 1 ELSE 0 END) ap,
            SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) rj
       FROM decisions WHERE date(created_at) = ?`,
    day,
  );

  // `fills` carries neither venue nor side — both live on the parent order.
  const f = one<{ n: number; fees: number | null }>(
    `SELECT COUNT(*) n, COALESCE(SUM(CAST(f.fee AS REAL)), 0) fees
       FROM fills f JOIN orders o ON o.id = f.order_id
      WHERE date(f.filled_at) = ? AND o.venue = ?`,
    day,
    venue,
  );

  // Realised P&L accrues on the position, not the fill: a sell realises against
  // whichever lots it consumed, which the fill row does not know about.
  const pnl = one<{ v: number | null }>(
    `SELECT COALESCE(SUM(CAST(realised_pnl AS REAL)), 0) v
       FROM positions
      WHERE venue = ? AND date(COALESCE(closed_at, opened_at)) = ?`,
    venue,
    day,
  );

  const open = one<{ n: number }>(
    `SELECT COUNT(*) n FROM positions WHERE venue = ? AND CAST(qty AS REAL) != 0`,
    venue,
  );

  const llm = one<{ n: number; c: number | null }>(
    `SELECT COUNT(*) n, COALESCE(SUM(CAST(cost_usd AS REAL)), 0) c
       FROM llm_calls WHERE date(created_at) = ?`,
    day,
  );

  const top = db
    .prepare(
      `SELECT reject_reason r FROM decisions
        WHERE date(created_at) = ? AND reject_reason IS NOT NULL
        GROUP BY reject_reason ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get(day) as { r: string } | undefined;

  return {
    day,
    decisions: d.n,
    approved: d.ap,
    rejected: d.rj,
    ordersFilled: f.n,
    realisedPnl: new Decimal(pnl.v ?? 0).toFixed(2),
    feesPaid: new Decimal(f.fees ?? 0).toFixed(4),
    openPositions: open.n,
    llmCalls: llm.n,
    llmCost: new Decimal(llm.c ?? 0).toFixed(4),
    topRejectReason: top?.r ?? null,
  } satisfies DaySummary;
}

export function summaryBody(
  s: DaySummary,
  tier: string,
  spent: string,
  remaining: string,
  lifetime?: { trades: number; winRate: number; realised: string; maxDrawdown: string },
): string {
  const pnl = new Decimal(s.realisedPnl);
  const life =
    lifetime === undefined || lifetime.trades === 0
      ? []
      : [
          '',
          'SINCE INCEPTION',
          `  Closed trades:  ${String(lifetime.trades)}`,
          `  Win rate:       ${(lifetime.winRate * 100).toFixed(1)}%`,
          `  Realised:       ${lifetime.realised}`,
          `  Max drawdown:   ${lifetime.maxDrawdown}`,
          lifetime.trades < 20
            ? '  Too few trades to draw a conclusion. Run `pnpm report` for the'
            : '  Run `pnpm report` for the',
          '  full breakdown and the comparison against buy-and-hold.',
        ];
  return [
    `Activity for ${s.day}`,
    '',
    `Decisions:        ${String(s.decisions)}  (${String(s.approved)} approved, ${String(s.rejected)} rejected)`,
    `Fills:            ${String(s.ordersFilled)}`,
    `Realised P&L:     ${pnl.gte(0) ? '+' : ''}${s.realisedPnl}`,
    `Fees paid:        ${s.feesPaid}`,
    `Open positions:   ${String(s.openPositions)}`,
    '',
    `Model calls:      ${String(s.llmCalls)}  ($${s.llmCost})`,
    `Budget:           $${spent} spent, $${remaining} left — tier ${tier}`,
    s.topRejectReason === null ? '' : `Most common block: ${s.topRejectReason}`,
    '',
    s.decisions === 0
      ? 'No decisions today. That is the expected state on most days: the earnings\n' +
        'calendar is sparse and the SUE gate rejects far more than it passes.'
      : '',
    ...life,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Emits one summary per calendar day, at most once.
 *
 * Idempotent on the day string rather than on a timer, so a restart cannot
 * produce a second summary and a machine asleep past midnight still gets one.
 */
export class DailySummary {
  private lastSent: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly budget: BudgetGovernor,
    private readonly venue: string,
    private readonly notify: (n: { kind: NotifyLike; subject: string; body: string }) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    const row = this.db
      .prepare(`SELECT MAX(date(created_at)) d FROM notifications WHERE kind = 'DAILY_SUMMARY'`)
      .get() as { d: string | null } | undefined;
    this.lastSent = row?.d ?? null;
  }

  /** Call freely; sends only when the day has rolled over. */
  maybeSend(): boolean {
    const now = this.now();
    const today = isoDay(now);
    if (this.lastSent === today) return false;
    // Summarise the day that just ended, not the one a few minutes old.
    const target = this.lastSent === null ? today : today;
    const s = collectSummary(this.db, this.venue, target);
    const life = summarise(closedTrades(this.db, this.venue));
    this.notify({
      kind: 'DAILY_SUMMARY',
      subject: `Aegis daily: ${String(s.ordersFilled)} fills, P&L ${s.realisedPnl}, ${String(s.openPositions)} open`,
      body: summaryBody(s, this.budget.tier(), this.budget.spent(), this.budget.remaining(), {
        trades: life.trades,
        winRate: life.winRate,
        realised: life.realised,
        maxDrawdown: life.maxDrawdown,
      }),
    });
    this.lastSent = today;
    return true;
  }
}

function isoDay(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

import type { BrokerAdapter, ReconciliationReport } from '@aegis/brokers';
import type { Db } from '@aegis/db';
import type { Ledger } from './ledger.js';

/**
 * Compares our ledger against the venue every interval.
 *
 * The ledger is our source of truth, but the venue is the arbiter. When they
 * disagree we stop rather than guess — a break blocks new orders for that venue
 * until a human resolves it, because a ledger that silently disagrees with the
 * broker is worse than having no ledger at all.
 */
export class Reconciler {
  private readonly callbacks = new Set<(r: ReconciliationReport) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ledger: Pick<Ledger, 'open'>,
    private readonly adapter: BrokerAdapter,
    private readonly db?: Db,
  ) {}

  onBreak(cb: (r: ReconciliationReport) => void): void {
    this.callbacks.add(cb);
  }

  async runOnce(): Promise<ReconciliationReport> {
    const report = await this.adapter.reconcile(this.ledger.open(this.adapter.venue));
    this.db
      ?.prepare('INSERT INTO reconciliations (venue, matched, breaks) VALUES (?,?,?)')
      .run(this.adapter.venue, report.matched ? 1 : 0, JSON.stringify(report.breaks));
    if (!report.matched) for (const cb of this.callbacks) cb(report);
    return report;
  }

  start(intervalMs = 60_000): () => void {
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
}

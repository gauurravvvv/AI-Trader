import type { Db } from '@aegis/db';
import type { Logger } from '@aegis/logger';

export type NotifyKind =
  | 'ORDER_SUBMITTED'
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED'
  | 'POSITION_EXITED'
  | 'RISK_BREACH'
  | 'RECONCILIATION_BREAK'
  | 'BUDGET_TIER'
  | 'KILL_SWITCH'
  | 'DAILY_SUMMARY';

/** These always send individually — never folded into a digest. */
const NEVER_DIGEST: ReadonlySet<NotifyKind> = new Set([
  'ORDER_REJECTED',
  'RISK_BREACH',
  'RECONCILIATION_BREAK',
  'KILL_SWITCH',
]);

export interface Notification {
  kind: NotifyKind;
  subject: string;
  body: string;
}

export interface Transport {
  name: string;
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Logs instead of sending. The default, so the system is fully runnable with no
 * email provider configured — a missing SMTP account should not silently
 * disable the audit trail of what the system decided.
 */
export class ConsoleTransport implements Transport {
  readonly name = 'console';
  constructor(private readonly log: Logger) {}
  async send(to: string, subject: string, body: string): Promise<void> {
    this.log.event('notifier', `[email → ${to}] ${subject}`);
    this.log.raw(body.split('\n').map((l) => `           | ${l}`).join('\n'));
  }
}

const DISCLAIMER =
  '\n---\nPAPER TRADING ONLY. No real money is at risk. This is educational and\n' +
  'research software and is not financial advice.\n';

export interface NotifierDeps {
  db: Db;
  log: Logger;
  transport: Transport;
  to: string;
  /** More than this many digestible events in the window collapses them. */
  digestThreshold?: number;
  digestWindowMs?: number;
}

/**
 * Outbox-pattern notifier.
 *
 * The notification row is written in the SAME transaction as the state change
 * it describes, so a send failure can never lose the record and a crash between
 * "traded" and "notified" is recoverable. A separate drain sends and retries;
 * a failed send never blocks or reverses a trade.
 */
export class Notifier {
  /** Where mail is going. Read at boot so the log can say. */
  get to(): string {
    return this.deps.to;
  }

  private readonly digestible: Notification[] = [];
  private windowStart = 0;

  constructor(private readonly deps: NotifierDeps) {}

  /** Enqueue. Safe to call inside an existing transaction. */
  enqueue(n: Notification): void {
    this.deps.db
      .prepare(
        `INSERT INTO notifications (kind, subject, body, status, attempts)
         VALUES (?,?,?, 'pending', 0)`,
      )
      .run(n.kind, n.subject, n.body + DISCLAIMER);
  }

  /**
   * Send everything pending. Digestible kinds collapse when they arrive in a
   * burst; rejections, risk breaches, reconciliation breaks and the kill switch
   * always send on their own, because those are exactly the ones you must not
   * discover buried in a summary.
   */
  async drain(maxAttempts = 5): Promise<{ sent: number; failed: number; digested: number }> {
    const pending = this.deps.db
      .prepare(
        `SELECT id, kind, subject, body, attempts FROM notifications
         WHERE status = 'pending' AND attempts < ? ORDER BY id ASC LIMIT 50`,
      )
      .all(maxAttempts) as { id: number; kind: NotifyKind; subject: string; body: string }[];

    if (pending.length === 0) return { sent: 0, failed: 0, digested: 0 };

    const urgent = pending.filter((p) => NEVER_DIGEST.has(p.kind));
    const rest = pending.filter((p) => !NEVER_DIGEST.has(p.kind));
    const threshold = this.deps.digestThreshold ?? 10;

    let sent = 0;
    let failed = 0;
    let digested = 0;

    for (const p of urgent) {
      (await this.deliver(p.id, p.subject, p.body)) ? sent++ : failed++;
    }

    if (rest.length > threshold) {
      const subject = `Aegis: ${String(rest.length)} events`;
      const body = rest.map((r) => `• ${r.subject}`).join('\n');
      if (await this.deliverDigest(rest.map((r) => r.id), subject, body)) {
        sent += 1;
        digested = rest.length;
      } else {
        failed += rest.length;
      }
    } else {
      for (const p of rest) {
        (await this.deliver(p.id, p.subject, p.body)) ? sent++ : failed++;
      }
    }

    return { sent, failed, digested };
  }

  private async deliver(id: number, subject: string, body: string): Promise<boolean> {
    try {
      await this.deps.transport.send(this.deps.to, subject, body);
      this.deps.db
        .prepare(`UPDATE notifications SET status='sent', sent_at=datetime('now') WHERE id = ?`)
        .run(id);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.db
        .prepare(
          `UPDATE notifications SET attempts = attempts + 1, last_error = ?,
             status = CASE WHEN attempts + 1 >= 5 THEN 'dead' ELSE 'pending' END
           WHERE id = ?`,
        )
        .run(msg, id);
      this.deps.log.warn('notifier', `send failed (${msg}) — will retry`);
      return false;
    }
  }

  private async deliverDigest(ids: number[], subject: string, body: string): Promise<boolean> {
    try {
      await this.deps.transport.send(this.deps.to, subject, body + DISCLAIMER);
      const ph = ids.map(() => '?').join(',');
      this.deps.db
        .prepare(
          `UPDATE notifications SET status='sent', sent_at=datetime('now') WHERE id IN (${ph})`,
        )
        .run(...ids);
      return true;
    } catch {
      return false;
    }
  }

  start(intervalMs = 15_000): () => void {
    const t = setInterval(() => {
      void this.drain();
    }, intervalMs);
    return () => {
      clearInterval(t);
    };
  }
}

/** Human-readable body for a fill. */
export function fillBody(o: {
  symbol: string;
  side: string;
  qty: string;
  price: string;
  fee: string;
  sue?: string | null;
  audit?: number | null;
  rationale?: string | null;
  thesisBreak?: string[];
}): string {
  const lines = [
    `${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ ${Number(o.price).toFixed(2)}`,
    `Fee: ${Number(o.fee).toFixed(4)}`,
    `Notional: ${(Number(o.qty) * Number(o.price)).toFixed(2)}`,
    '',
  ];
  if (o.sue != null) lines.push(`SUE score:      ${o.sue}`);
  if (o.audit != null) lines.push(`Audit score:    ${String(o.audit)}/100`);
  if (o.rationale) lines.push('', 'Why:', o.rationale);
  if (o.thesisBreak && o.thesisBreak.length > 0) {
    lines.push('', 'This thesis breaks if:', ...o.thesisBreak.map((t) => `  • ${t}`));
  }
  return lines.join('\n');
}

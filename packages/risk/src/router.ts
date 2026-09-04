import Decimal from 'decimal.js';
import type { Db } from '@aegis/db';
import type { BrokerAdapter, FillEvent } from '@aegis/brokers';
import type { Ledger } from '@aegis/ledger';
import { evaluate, maxPermittedQty, DEFAULT_LIMITS, type RiskLimits } from './officer.js';
import type { RiskContext, RiskEvaluation } from './officer.js';

export interface RouteRequest {
  decisionId: number;
  rungIndex?: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  price: string;
  /** When true, an oversized order is shrunk to the largest permitted size
   *  instead of being rejected outright. */
  allowResize?: boolean;
}

export type RouteOutcome =
  | { ok: true; orderId: number; venueOrderId: string; qty: string; resized: boolean }
  | { ok: false; reason: string; evaluation: RiskEvaluation };

/**
 * Raised when an order is sent or refused.
 *
 * Structurally typed rather than importing `@aegis/notify`: the router should
 * not need to know an email system exists in order to report a breach, and a
 * test can satisfy it with `(n) => seen.push(n)`.
 */
export interface RouterNotify {
  (n: { kind: 'ORDER_SUBMITTED' | 'RISK_BREACH'; subject: string; body: string }): void;
}

/**
 * Reject codes that mean a limit was actually breached, as opposed to an order
 * merely being too large. A resize is routine and not worth an alert; a halt,
 * a blocklisted symbol or a tripped daily loss stop is the operator's business.
 */
const BREACH_CODES: ReadonlySet<string> = new Set([
  'HALTED',
  'BLOCKLIST',
  'DAILY_LOSS_STOP',
  'MAX_POSITIONS',
  'DUPLICATE',
  'NO_QUOTE',
]);

export interface RouterDeps {
  db: Db;
  adapter: BrokerAdapter;
  ledger: Ledger;
  limits?: RiskLimits;
  onFill?: (f: FillEvent) => void;
  notify?: RouterNotify;
}

/** Read the global kill switch. Checked immediately before every send. */
export function isHalted(db: Db): boolean {
  const r = db.prepare('SELECT halted FROM system_state WHERE id = 1').get() as
    | { halted: number }
    | undefined;
  return r?.halted === 1;
}

export function setHalt(db: Db, halted: boolean, reason?: string): void {
  db.prepare(
    `UPDATE system_state SET halted = ?, halt_reason = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(halted ? 1 : 0, reason ?? null);
}

export class OrderRouter {
  /** The venue this router trades. Read by agents that query per-venue state. */
  readonly venue: string;
  private readonly db: Db;
  private readonly adapter: BrokerAdapter;
  private readonly ledger: Ledger;
  private readonly limits: RiskLimits;
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: RouterDeps) {
    this.db = deps.db;
    this.adapter = deps.adapter;
    this.ledger = deps.ledger;
    this.limits = deps.limits ?? DEFAULT_LIMITS;
    this.venue = deps.adapter.venue;
  }

  /** Subscribe to venue fills and apply them to the ledger. */
  start(): void {
    this.unsub = this.adapter.streamFills((f) => {
      const row = this.db
        .prepare('SELECT id FROM orders WHERE client_order_id = ? AND venue = ?')
        .get(f.clientOrderId, this.adapter.venue) as { id: number } | undefined;
      if (!row) return; // a fill for an order we never placed — ignore, reconciler will catch it
      this.ledger.applyFill(f, row.id, this.adapter.venue);
      this.db
        .prepare(
          `UPDATE orders SET status = 'filled', venue_order_id = ? WHERE id = ?`,
        )
        .run(f.venueOrderId, row.id);
      this.deps.onFill?.(f);
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /**
   * Round trips opened and closed on the same day, over the last five sessions.
   *
   * Counted from fills rather than positions, because a position that was
   * opened and closed twice in a week is two day trades and the position row
   * only remembers the last one.
   */
  dayTradesLast5Days(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) c FROM (
           SELECT date(f.filled_at) d, o.symbol
             FROM fills f JOIN orders o ON o.id = f.order_id
            WHERE o.venue = ? AND date(f.filled_at) >= date('now', '-7 days')
            GROUP BY date(f.filled_at), o.symbol
           HAVING SUM(CASE WHEN o.side = 'buy' THEN 1 ELSE 0 END) > 0
              AND SUM(CASE WHEN o.side = 'sell' THEN 1 ELSE 0 END) > 0
         )`,
      )
      .get(this.adapter.venue) as { c: number };
    return r.c;
  }

  /** Would this sell close something bought today? */
  private wouldBeDayTrade(symbol: string, side: 'buy' | 'sell'): boolean {
    if (side !== 'sell') return false;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) c FROM fills f JOIN orders o ON o.id = f.order_id
          WHERE o.venue = ? AND o.symbol = ? AND o.side = 'buy'
            AND date(f.filled_at) = date('now')`,
      )
      .get(this.adapter.venue, symbol) as { c: number };
    return r.c > 0;
  }

  async buildContext(): Promise<Omit<RiskContext, 'adv' | 'duplicateRecent' | 'wouldBeDayTrade'>> {
    const acct = await this.adapter.getAccount();
    const open = this.ledger.open(this.adapter.venue);
    let gross = new Decimal(0);
    for (const p of open) {
      const q = await this.adapter.getQuote(p.symbol);
      const mark = q ? new Decimal(q.last) : new Decimal(p.avgCost);
      gross = gross.plus(mark.times(p.qty).abs());
    }
    return {
      halted: isHalted(this.db),
      marketOpen: this.adapter.calendar.isOpen(new Date()),
      equity: acct.equity,
      cash: acct.cash,
      grossExposure: gross.toFixed(2),
      marketExposure: gross.toFixed(2), // one venue per market in v1
      openPositions: this.ledger.openCount(this.adapter.venue),
      realisedPnlToday: this.ledger.realisedToday(this.adapter.venue),
      dayTradesLast5Days: this.dayTradesLast5Days(),
      // PDT is a US margin-equity rule. Crypto and India are not subject to it,
      // and applying it there would invent a constraint that does not exist.
      pdtApplies: this.adapter.market === 'US',
    };
  }

  private recentDuplicate(decisionId: number, symbol: string, side: string): boolean {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) c FROM orders
         WHERE symbol = ? AND side = ? AND venue = ? AND decision_id != ?
           AND created_at > datetime('now', '-60 seconds')`,
      )
      .get(symbol, side, this.adapter.venue, decisionId) as { c: number };
    return r.c > 0;
  }

  async route(req: RouteRequest, adv: string | null): Promise<RouteOutcome> {
    const rung = req.rungIndex ?? 0;

    // Idempotency: the DB unique constraint is the real guard, but check first
    // so a restart mid-flight returns the existing order instead of throwing.
    const existing = this.db
      .prepare('SELECT id, venue_order_id, qty FROM orders WHERE decision_id = ? AND rung_index = ?')
      .get(req.decisionId, rung) as { id: number; venue_order_id: string | null; qty: string } | undefined;
    if (existing) {
      return {
        ok: true,
        orderId: existing.id,
        venueOrderId: existing.venue_order_id ?? '',
        qty: existing.qty,
        resized: false,
      };
    }

    const base = await this.buildContext();
    const ctx: RiskContext = {
      ...base,
      adv,
      duplicateRecent: this.recentDuplicate(req.decisionId, req.symbol, req.side),
      wouldBeDayTrade: this.wouldBeDayTrade(req.symbol, req.side),
    };

    let qty = req.qty;
    let resized = false;
    let evaluation = evaluate({ ...req, qty }, ctx, this.limits);

    // Resize only when the sole problem is size. A halt, a blocklist or a
    // closed market is never solved by trading less.
    const sizingOnly = evaluation.rejectReasons.every((c) =>
      ['POSITION_CAP', 'MARKET_CAP', 'GROSS_EXPOSURE', 'LIQUIDITY', 'INSUFFICIENT_CASH'].includes(c),
    );
    if (!evaluation.passed && req.allowResize === true && sizingOnly) {
      const permitted = maxPermittedQty(req.price, ctx, this.limits);
      if (new Decimal(permitted).gt(0)) {
        qty = permitted;
        resized = true;
        evaluation = evaluate({ ...req, qty }, ctx, this.limits);
      }
    }

    this.db
      .prepare(
        'INSERT INTO risk_evaluations (decision_id, passed, checks, reject_reasons) VALUES (?,?,?,?)',
      )
      .run(
        req.decisionId,
        evaluation.passed ? 1 : 0,
        JSON.stringify(evaluation.checks),
        JSON.stringify(evaluation.rejectReasons),
      );

    if (!evaluation.passed) {
      this.db
        .prepare(`UPDATE decisions SET status = 'REJECTED', reject_reason = ? WHERE id = ?`)
        .run(evaluation.rejectReasons.join(','), req.decisionId);
      const breaches = evaluation.rejectReasons.filter((c) => BREACH_CODES.has(c));
      if (breaches.length > 0) {
        this.deps.notify?.({
          kind: 'RISK_BREACH',
          subject: `Aegis: ${req.symbol} ${req.side.toUpperCase()} blocked — ${breaches.join(', ')}`,
          body: [
            `${req.side.toUpperCase()} ${req.qty} ${req.symbol} was refused by the Risk Officer.`,
            '',
            'Failed checks:',
            ...evaluation.checks.filter((c) => !c.passed).map((c) => `  • ${c.name}: ${c.detail}`),
          ].join('\n'),
        });
      }
      return { ok: false, reason: evaluation.rejectReasons.join(','), evaluation };
    }

    const clientOrderId = `${String(req.decisionId)}:${String(rung)}`;
    const ins = this.db
      .prepare(
        `INSERT INTO orders (decision_id, rung_index, venue, client_order_id, symbol, side, type, qty, status, submitted_at)
         VALUES (?,?,?,?,?,?,'market',?, 'submitted', datetime('now'))`,
      )
      .run(req.decisionId, rung, this.adapter.venue, clientOrderId, req.symbol, req.side, qty);
    const orderId = Number(ins.lastInsertRowid);

    // Re-check the halt flag immediately before the send. The gap between
    // evaluation and transmission is exactly where a kill switch must land.
    if (isHalted(this.db)) {
      this.db
        .prepare(`UPDATE orders SET status = 'cancelled', reject_reason = 'HALTED' WHERE id = ?`)
        .run(orderId);
      return { ok: false, reason: 'HALTED', evaluation };
    }

    const venueOrder = await this.adapter.submitOrder({
      clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: 'market',
      qty,
    });

    this.db
      .prepare('UPDATE orders SET venue_order_id = ?, status = ? WHERE id = ?')
      .run(venueOrder.venueOrderId, venueOrder.status, orderId);
    this.db
      .prepare(`UPDATE decisions SET status = 'EXECUTED' WHERE id = ?`)
      .run(req.decisionId);

    this.deps.notify?.({
      kind: 'ORDER_SUBMITTED',
      subject: `Aegis: ${req.side.toUpperCase()} ${qty} ${req.symbol} submitted`,
      body: [
        `${req.side.toUpperCase()} ${qty} ${req.symbol} @ ~${Number(req.price).toFixed(2)}`,
        `Venue:    ${this.adapter.venue}`,
        `Order:    ${clientOrderId} → ${venueOrder.venueOrderId}`,
        resized ? `Resized:  from ${req.qty} to ${qty} by the Risk Officer` : '',
        '',
        'A separate notification follows when the venue reports the fill.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    });

    return { ok: true, orderId, venueOrderId: venueOrder.venueOrderId, qty, resized };
  }
}

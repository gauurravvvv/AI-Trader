import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { BudgetGovernor } from '@aegis/budget';
import { Ledger } from '@aegis/ledger';
import { DailySummary, collectSummary, summaryBody } from './summary.js';

let db: Db;
let budget: BudgetGovernor;
let ledger: Ledger;
const VENUE = 'sim-us';
/** The ledger stamps `opened_at`/`closed_at` with the DB clock, so the day the
 *  summary reads is always "today" — computing it keeps the test date-proof. */
const DAY = new Date().toISOString().slice(0, 10);
let seq = 0;

/** Writes through the real ledger rather than hand-inserting rows, so the test
 *  fails if the schema or the fill-application logic changes underneath it. */
function seedFill(side: 'buy' | 'sell', qty: string, price: string, fee: string): void {
  seq += 1;
  const d = db
    .prepare(`INSERT INTO decisions (symbol, market, venue, side, status) VALUES ('NVDA','US',?,?,'EXECUTED')`)
    .run(VENUE, side);
  const o = db
    .prepare(
      `INSERT INTO orders (decision_id, rung_index, venue, client_order_id, symbol, side, type, qty, status)
       VALUES (?,0,?,?, 'NVDA', ?, 'market', ?, 'filled')`,
    )
    .run(d.lastInsertRowid, VENUE, `c${String(seq)}`, side, qty);
  ledger.applyFill(
    {
      clientOrderId: `c${String(seq)}`,
      venueOrderId: `v${String(seq)}`,
      venueFillId: `f${String(seq)}`,
      symbol: 'NVDA',
      side,
      qty,
      price,
      fee,
      filledAt: new Date().toISOString(),
    },
    Number(o.lastInsertRowid),
    VENUE,
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  budget = new BudgetGovernor(db, 100, '2026-09-01');
  ledger = new Ledger(db);
  seq = 0;
});

describe('collectSummary', () => {
  it('reports a quiet day as genuinely quiet rather than as an error', () => {
    const s = collectSummary(db, VENUE, DAY);
    expect(s.decisions).toBe(0);
    expect(s.ordersFilled).toBe(0);
    expect(s.realisedPnl).toBe('0.00');
    expect(summaryBody(s, 'NORMAL', '0', '100')).toContain('No decisions today');
  });

  it('counts approvals and rejections separately', () => {
    db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side, status) VALUES ('AAPL','US',?, 'buy','APPROVED')`,
    ).run(VENUE);
    db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side, status, reject_reason)
       VALUES ('AMD','US',?, 'buy','REJECTED','POSITION_CAP')`,
    ).run(VENUE);
    const s = collectSummary(db, VENUE, DAY);
    expect(s.decisions).toBe(2);
    expect(s.approved).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.topRejectReason).toBe('POSITION_CAP');
  });

  it('counts fills through the parent order and sums their fees', () => {
    seedFill('buy', '10', '100', '1.00');
    seedFill('sell', '10', '125', '1.00');
    const s = collectSummary(db, VENUE, DAY);
    expect(s.ordersFilled).toBe(2);
    expect(s.feesPaid).toBe('2.0000');
  });

  it('reports realised P&L booked by the ledger, net of the entry cost', () => {
    seedFill('buy', '10', '100', '0');
    seedFill('sell', '10', '125', '0');
    // 10 shares bought at 100, sold at 125 → 250 realised.
    expect(collectSummary(db, VENUE, DAY).realisedPnl).toBe('250.00');
  });

  it('does not count another venue as ours', () => {
    seedFill('buy', '10', '100', '1.00');
    seedFill('sell', '10', '125', '1.00');
    const other = collectSummary(db, 'sim-crypto', DAY);
    expect(other.ordersFilled).toBe(0);
    expect(other.realisedPnl).toBe('0.00');
  });

  it('renders a signed P&L so a loss cannot be misread as a gain', () => {
    const s = collectSummary(db, VENUE, DAY);
    expect(summaryBody({ ...s, realisedPnl: '-40.00' }, 'NORMAL', '1', '99')).toContain('-40.00');
    expect(summaryBody({ ...s, realisedPnl: '40.00' }, 'NORMAL', '1', '99')).toContain('+40.00');
  });
});

describe('DailySummary', () => {
  it('sends once per day and not again', () => {
    const seen: { kind: string }[] = [];
    let today = new Date(`${DAY}T18:00:00`);
    const ds = new DailySummary(db, budget, VENUE, (n) => seen.push(n), () => today);

    expect(ds.maybeSend()).toBe(true);
    expect(ds.maybeSend()).toBe(false);
    expect(ds.maybeSend()).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('DAILY_SUMMARY');

    today = new Date(new Date(`${DAY}T18:00:00`).getTime() + 86_400_000);
    expect(ds.maybeSend()).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('does not re-send after a restart on the same day', () => {
    const seen: unknown[] = [];
    const at = (): Date => new Date(`${DAY}T18:00:00`);
    const first = new DailySummary(db, budget, VENUE, (n) => {
      seen.push(n);
      db.prepare(
        `INSERT INTO notifications (kind, subject, body, status, attempts) VALUES (?,?,?, 'pending', 0)`,
      ).run(n.kind, n.subject, n.body);
    }, at);
    expect(first.maybeSend()).toBe(true);

    // A fresh instance reads the outbox and knows today is already covered.
    const second = new DailySummary(db, budget, VENUE, (n) => seen.push(n), at);
    expect(second.maybeSend()).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('lifetime performance in the daily summary', () => {
  it('omits the section entirely before anything has closed', () => {
    const s = collectSummary(db, VENUE, DAY);
    const body = summaryBody(s, 'NORMAL', '0', '100', {
      trades: 0, winRate: 0, realised: '0.00', maxDrawdown: '0.00',
    });
    expect(body).not.toContain('SINCE INCEPTION');
  });

  it('reports lifetime figures once trades have closed', () => {
    const s = collectSummary(db, VENUE, DAY);
    const body = summaryBody(s, 'NORMAL', '0', '100', {
      trades: 6, winRate: 0.5, realised: '120.00', maxDrawdown: '45.00',
    });
    expect(body).toContain('SINCE INCEPTION');
    expect(body).toContain('50.0%');
    expect(body).toContain('45.00');
    expect(body).toContain('Too few trades to draw a conclusion');
  });

  it('stops disclaiming once the sample is large enough to mean something', () => {
    const body = summaryBody(collectSummary(db, VENUE, DAY), 'NORMAL', '0', '100', {
      trades: 40, winRate: 0.55, realised: '900.00', maxDrawdown: '120.00',
    });
    expect(body).not.toContain('Too few trades');
    expect(body).toContain('buy-and-hold');
  });
});

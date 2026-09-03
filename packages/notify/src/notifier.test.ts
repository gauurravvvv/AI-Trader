import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import { createLogger } from '@aegis/logger';
import { Notifier, fillBody, type Transport } from './notifier.js';

class Capture implements Transport {
  readonly name = 'capture';
  sent: { subject: string; body: string }[] = [];
  failTimes = 0;
  async send(_to: string, subject: string, body: string): Promise<void> {
    if (this.failTimes > 0) { this.failTimes -= 1; throw new Error('smtp down'); }
    this.sent.push({ subject, body });
  }
}

let db: Db;
let t: Capture;
let n: Notifier;

beforeEach(() => {
  db = openDb(':memory:');
  t = new Capture();
  n = new Notifier({ db, log: createLogger({ colour: false, sink: () => {} }), transport: t, to: 'x@y.z' });
});

describe('Notifier', () => {
  it('sends a queued notification', async () => {
    n.enqueue({ kind: 'ORDER_FILLED', subject: 'BUY 10 NVDA', body: 'filled' });
    const r = await n.drain();
    expect(r.sent).toBe(1);
    expect(t.sent[0]!.subject).toBe('BUY 10 NVDA');
  });

  it('appends the paper-trading disclaimer to every message', async () => {
    n.enqueue({ kind: 'ORDER_FILLED', subject: 's', body: 'b' });
    await n.drain();
    expect(t.sent[0]!.body).toContain('PAPER TRADING ONLY');
  });

  it('keeps the row pending and retries when the transport fails', async () => {
    t.failTimes = 1;
    n.enqueue({ kind: 'ORDER_FILLED', subject: 's', body: 'b' });
    expect((await n.drain()).failed).toBe(1);
    expect((await n.drain()).sent).toBe(1);
  });

  it('gives up into a dead state rather than retrying forever', async () => {
    t.failTimes = 99;
    n.enqueue({ kind: 'ORDER_FILLED', subject: 's', body: 'b' });
    for (let i = 0; i < 6; i++) await n.drain();
    const row = db.prepare('SELECT status FROM notifications').get() as { status: string };
    expect(row.status).toBe('dead');
  });

  it('digests a burst of routine events', async () => {
    for (let i = 0; i < 15; i++) {
      n.enqueue({ kind: 'ORDER_FILLED', subject: `fill ${String(i)}`, body: 'b' });
    }
    const r = await n.drain();
    expect(r.digested).toBe(15);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.subject).toContain('15 events');
  });

  it('NEVER digests a rejection, a risk breach, or the kill switch', async () => {
    for (let i = 0; i < 15; i++) {
      n.enqueue({ kind: 'ORDER_FILLED', subject: `fill ${String(i)}`, body: 'b' });
    }
    n.enqueue({ kind: 'ORDER_REJECTED', subject: 'REJECTED NVDA', body: 'cap breach' });
    n.enqueue({ kind: 'KILL_SWITCH', subject: 'HALTED', body: 'engaged' });
    await n.drain();
    const subjects = t.sent.map((s) => s.subject);
    expect(subjects).toContain('REJECTED NVDA');
    expect(subjects).toContain('HALTED');
  });

  it('does not resend an already-sent notification', async () => {
    n.enqueue({ kind: 'ORDER_FILLED', subject: 's', body: 'b' });
    await n.drain();
    await n.drain();
    expect(t.sent).toHaveLength(1);
  });

  it('drains cleanly on an empty outbox', async () => {
    expect(await n.drain()).toEqual({ sent: 0, failed: 0, digested: 0 });
  });
});

describe('fillBody', () => {
  it('carries the reasoning and the thesis-break conditions', () => {
    const b = fillBody({
      symbol: 'NVDA', side: 'buy', qty: '26', price: '185.42', fee: '0.01',
      sue: '2.14', audit: 78, rationale: 'guidance raised',
      thesisBreak: ['guidance lowered next quarter'],
    });
    expect(b).toContain('BUY 26 NVDA @ 185.42');
    expect(b).toContain('SUE score:      2.14');
    expect(b).toContain('78/100');
    expect(b).toContain('This thesis breaks if:');
  });

  it('omits optional sections cleanly', () => {
    const b = fillBody({ symbol: 'X', side: 'sell', qty: '1', price: '10', fee: '0' });
    expect(b).toContain('SELL 1 X @ 10.00');
    expect(b).not.toContain('SUE score');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import type { BrokerAdapter } from './types.js';

/**
 * Every adapter must pass this identically. Adding a venue is one file plus a
 * green run of this suite — agent code never learns which venue it is on.
 */
export function runConformanceSuite(name: string, factory: () => Promise<BrokerAdapter>): void {
  describe(`BrokerAdapter conformance: ${name}`, () => {
    let a: BrokerAdapter;
    beforeEach(async () => {
      a = await factory();
    });

    it('declares paper mode (INV-1)', () => {
      expect(a.mode).toBe('paper');
    });

    it('returns an account with numeric-string equity', async () => {
      const acct = await a.getAccount();
      expect(acct.equity).toMatch(/^-?\d+(\.\d+)?$/);
      expect(acct.currency).toMatch(/^[A-Z]{3,4}$/);
    });

    it('submits an order and echoes the clientOrderId back', async () => {
      const o = await a.submitOrder({
        clientOrderId: '1:0', symbol: 'TEST', side: 'buy', type: 'market', qty: '10',
      });
      expect(o.clientOrderId).toBe('1:0');
      expect(o.venueOrderId).toBeTruthy();
    });

    it('is idempotent on clientOrderId — a restart must not double-place', async () => {
      const req = {
        clientOrderId: '2:0', symbol: 'TEST', side: 'buy' as const,
        type: 'market' as const, qty: '10',
      };
      const first = await a.submitOrder(req);
      const second = await a.submitOrder(req);
      expect(second.venueOrderId).toBe(first.venueOrderId);
    });

    it('emits a fill carrying a unique venueFillId', async () => {
      const seen: string[] = [];
      const stop = a.streamFills((e) => seen.push(e.venueFillId));
      await a.submitOrder({
        clientOrderId: '3:0', symbol: 'TEST', side: 'buy', type: 'market', qty: '10',
      });
      await new Promise((r) => setTimeout(r, 300));
      stop();
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('reports a break when the ledger disagrees', async () => {
      const r = await a.reconcile([{ symbol: 'TEST', qty: '99999', avgCost: '1' }]);
      expect(r.matched).toBe(false);
      expect(r.breaks.length).toBeGreaterThan(0);
    });

    it('exposes constraints as decimal strings', () => {
      expect(a.constraints.tickSize).toMatch(/^\d+(\.\d+)?$/);
      expect(a.constraints.minNotional).toMatch(/^\d+(\.\d+)?$/);
    });
  });
}

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@aegis/db';
import {
  recordProvenance, provenanceFor, degradedDecisions, provenanceSummary,
} from './provenance.js';

let db: Db;

function decision(symbol = 'NVDA'): number {
  return Number(
    db.prepare(
      `INSERT INTO decisions (symbol, market, venue, side, status) VALUES (?, 'US','sim-us','buy','EXECUTED')`,
    ).run(symbol).lastInsertRowid,
  );
}

beforeEach(() => { db = openDb(':memory:'); });

describe('recordProvenance', () => {
  it('stores one row per source, in order', () => {
    const id = decision();
    recordProvenance(db, id, [
      { kind: 'filing', source: 'edgar', reference: '0001045810-26-000073', asOf: '2026-08-26T20:21:00Z' },
      { kind: 'consensus', source: 'yahoo', reference: 'NVDA' },
      { kind: 'quote', source: 'yahoo', reference: 'NVDA' },
    ]);
    const rows = provenanceFor(db, id);
    expect(rows.map((r) => r.kind)).toEqual(['filing', 'consensus', 'quote']);
    expect(rows[0]!.reference).toBe('0001045810-26-000073');
  });

  it('separates when we fetched a fact from when it was true', () => {
    const id = decision();
    recordProvenance(db, id, [{
      kind: 'filing', source: 'edgar',
      retrievedAt: '2026-09-04T13:00:00Z',
      asOf: '2026-08-26T20:21:00Z',
    }]);
    const r = provenanceFor(db, id)[0]!;
    expect(r.retrieved_at).toBe('2026-09-04T13:00:00Z');
    expect(r.as_of).toBe('2026-08-26T20:21:00Z');
  });

  it('flags a degraded source so it can be found later', () => {
    const id = decision();
    recordProvenance(db, id, [
      { kind: 'quote', source: 'yahoo', degraded: true, note: 'spread was synthesised' },
    ]);
    expect(provenanceFor(db, id)[0]!.degraded).toBe(1);
  });

  it('defaults degraded to false rather than null', () => {
    const id = decision();
    recordProvenance(db, id, [{ kind: 'news', source: 'yahoo' }]);
    expect(provenanceFor(db, id)[0]!.degraded).toBe(0);
  });

  it('writes nothing for an empty source list', () => {
    const id = decision();
    recordProvenance(db, id, []);
    expect(provenanceFor(db, id)).toEqual([]);
  });
});

describe('degradedDecisions', () => {
  it('finds every decision built on a weak input', () => {
    const a = decision('NVDA');
    const b = decision('AMD');
    recordProvenance(db, a, [{ kind: 'quote', source: 'yahoo', degraded: true }]);
    recordProvenance(db, b, [{ kind: 'quote', source: 'yahoo' }]);
    const rows = degradedDecisions(db);
    expect(rows.map((r) => r.decision_id)).toEqual([a]);
    expect(rows[0]!.kinds).toContain('quote');
  });

  it('lists each decision once even with several weak sources', () => {
    const a = decision();
    recordProvenance(db, a, [
      { kind: 'quote', source: 'yahoo', degraded: true },
      { kind: 'consensus', source: 'yahoo', degraded: true },
    ]);
    const rows = degradedDecisions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kinds.split(',').sort()).toEqual(['consensus', 'quote']);
  });

  it('returns nothing when every input was sound', () => {
    recordProvenance(db, decision(), [{ kind: 'filing', source: 'edgar' }]);
    expect(degradedDecisions(db)).toEqual([]);
  });
});

describe('provenanceSummary', () => {
  it('renders sources compactly and marks the weak ones', () => {
    const id = decision();
    recordProvenance(db, id, [
      { kind: 'filing', source: 'edgar', reference: 'acc-1', asOf: '2026-08-26T20:21:00Z' },
      { kind: 'quote', source: 'yahoo', degraded: true },
    ]);
    const out = provenanceSummary(provenanceFor(db, id));
    expect(out).toContain('filing:edgar acc-1');
    expect(out).toContain('[DEGRADED]');
  });

  it('says so plainly when nothing was recorded', () => {
    expect(provenanceSummary([])).toBe('no sources recorded');
  });
});

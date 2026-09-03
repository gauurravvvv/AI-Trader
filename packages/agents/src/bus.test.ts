import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@aegis/db';
import { SignalBus } from './bus.js';

let bus: SignalBus;
beforeEach(() => {
  bus = new SignalBus(openDb(':memory:'));
});

describe('SignalBus', () => {
  it('emits and reads back an unconsumed signal', () => {
    bus.emit({ agent: 'edgar-poller', signalType: 'filing_8k', symbol: 'NVDA', data: { acc: '123' } });
    const got = bus.read(['filing_8k']);
    expect(got).toHaveLength(1);
    expect(got[0]!.symbol).toBe('NVDA');
    expect(got[0]!.data).toEqual({ acc: '123' });
  });

  it('filters by signal type', () => {
    bus.emit({ agent: 'a', signalType: 'filing_8k', symbol: 'X' });
    bus.emit({ agent: 'b', signalType: 'bearish_news', symbol: 'Y' });
    expect(bus.read(['filing_8k'])).toHaveLength(1);
    expect(bus.read(['filing_8k', 'bearish_news'])).toHaveLength(2);
  });

  it('does not return consumed signals — the core guarantee', () => {
    const id = bus.emit({ agent: 'a', signalType: 'filing_8k', symbol: 'X' });
    bus.consume([id], 'earnings-reader');
    expect(bus.read(['filing_8k'])).toHaveLength(0);
  });

  it('records who consumed it and when', () => {
    const id = bus.emit({ agent: 'a', signalType: 'filing_8k', symbol: 'X' });
    bus.consume([id], 'earnings-reader');
    const row = bus.byId(id)!;
    expect(row.consumedBy).toBe('earnings-reader');
    expect(row.consumedAt).not.toBeNull();
  });

  it('consume([]) is a no-op rather than a malformed query', () => {
    expect(() => { bus.consume([], 'x'); }).not.toThrow();
  });

  it('read([]) returns empty rather than a malformed query', () => {
    expect(bus.read([])).toEqual([]);
  });

  it('returns newest first', () => {
    bus.emit({ agent: 'a', signalType: 't', symbol: 'FIRST' });
    bus.emit({ agent: 'a', signalType: 't', symbol: 'SECOND' });
    expect(bus.read(['t'])[0]!.symbol).toBe('SECOND');
  });

  it('round-trips a JSON payload without loss', () => {
    const data = { nested: { a: [1, 2, 3] }, s: 'x', n: 1.5, b: true, nil: null };
    const id = bus.emit({ agent: 'a', signalType: 't', data });
    expect(bus.byId(id)!.data).toEqual(data);
  });
});

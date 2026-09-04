import { describe, it, expect } from 'vitest';
import { isAbout, newestFirst, withinHours, YahooNewsSource, type NewsItem } from './news.js';

const story = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  uuid: 'u1', title: 'NVIDIA raises guidance', publisher: 'Reuters',
  type: 'STORY', relatedTickers: ['NVDA'], ...over,
});

describe('isAbout', () => {
  it('keeps a story Yahoo attributed to the symbol', () => {
    expect(isAbout(story(), 'NVDA', 'NVDA')).toBe(true);
  });

  it('keeps a story matched on the Yahoo-suffixed symbol', () => {
    expect(isAbout(story({ relatedTickers: ['BTC-USD'] }), 'BTC', 'BTC-USD')).toBe(true);
  });

  it('rejects the generic feed Yahoo returns when it has nothing for a ticker', () => {
    // Observed live: a RELIANCE.NS query returns tennis and feng-shui press
    // releases. They read as plausible prose to a model told they are about
    // Reliance Industries, so they must never reach one.
    expect(isAbout({ title: 'Night-owl Zverev goes distance at US Open', type: 'STORY' },
      'RELIANCE', 'RELIANCE.NS')).toBe(false);
    expect(isAbout({ title: 'Why Robinhood Stock Skyrocketed', type: 'STORY', relatedTickers: ['HOOD', 'NVDA'] },
      'RELIANCE', 'RELIANCE.NS')).toBe(false);
  });

  it('rejects a video — there is no body for the model to weigh', () => {
    expect(isAbout(story({ type: 'VIDEO' }), 'NVDA', 'NVDA')).toBe(false);
  });

  it('rejects an untitled story', () => {
    expect(isAbout(story({ title: '   ' }), 'NVDA', 'NVDA')).toBe(false);
  });

  it('accepts a story that mentions several tickers including ours', () => {
    expect(isAbout(story({ relatedTickers: ['AMD', 'INTC', 'NVDA'] }), 'NVDA', 'NVDA')).toBe(true);
  });

  it('is case-insensitive on the ticker', () => {
    expect(isAbout(story({ relatedTickers: ['nvda'] }), 'NVDA', 'NVDA')).toBe(true);
  });
});

const item = (id: string, publishedAt: string): NewsItem => ({
  id, symbol: 'NVDA', title: id, publisher: 'p', link: '', publishedAt, relatedTickers: ['NVDA'],
});

describe('ordering and freshness', () => {
  it('puts the newest story first', () => {
    const out = newestFirst([
      item('old', '2026-09-01T00:00:00Z'),
      item('new', '2026-09-04T00:00:00Z'),
    ]);
    expect(out[0]!.id).toBe('new');
  });

  it('drops stories older than the window', () => {
    const now = Date.parse('2026-09-04T12:00:00Z');
    const out = withinHours(
      [item('fresh', '2026-09-04T06:00:00Z'), item('stale', '2026-09-01T06:00:00Z')],
      36,
      now,
    );
    expect(out.map((i) => i.id)).toEqual(['fresh']);
  });

  it('drops a story with an unparseable date rather than assuming it is fresh', () => {
    expect(withinHours([item('bad', 'not a date')], 36)).toHaveLength(0);
  });
});

describe('isNew', () => {
  it('returns true once per id, then false', () => {
    const s = new YahooNewsSource();
    expect(s.isNew('a')).toBe(true);
    expect(s.isNew('a')).toBe(false);
    expect(s.isNew('b')).toBe(true);
  });

  it('forgets an id once the TTL has passed', async () => {
    const s = new YahooNewsSource(10);
    expect(s.isNew('a')).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    expect(s.isNew('a')).toBe(true);
  });
});

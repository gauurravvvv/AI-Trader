import YahooFinance from 'yahoo-finance2';
import type { MarketId } from '@aegis/config';
import { YahooPriceSource } from './yahoo.js';

export interface NewsItem {
  id: string;
  symbol: string;
  title: string;
  publisher: string;
  link: string;
  publishedAt: string;
  /** Every ticker Yahoo associated with the story. */
  relatedTickers: string[];
}

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

interface RawNews {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: Date | string;
  type?: string;
  relatedTickers?: string[];
}

/**
 * Headlines for a symbol, from Yahoo's keyless search endpoint.
 *
 * The strict `relatedTickers` filter is not defensive tidying — it is load-
 * bearing. Yahoo's search silently falls back to a generic news feed when it
 * has nothing for a ticker: a query for RELIANCE.NS returns tennis results and
 * feng-shui press releases, all of which read as plausible prose to a model
 * that was told they concern Reliance Industries. Returning nothing for a
 * symbol we have no news for is correct; returning someone else's news is not.
 */
export class YahooNewsSource {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  async headlines(symbol: string, market: MarketId, limit = 8): Promise<NewsItem[]> {
    const yahooSymbol = YahooPriceSource.symbolFor(symbol, market);
    let raw: RawNews[];
    try {
      const res = await yf.search(yahooSymbol, { newsCount: limit, quotesCount: 0 });
      raw = (res.news ?? []) as RawNews[];
    } catch {
      return [];
    }
    return raw.filter((n) => isAbout(n, symbol, yahooSymbol)).map((n) => toItem(n, symbol));
  }

  /** True the first time an id is offered, false thereafter within the TTL. */
  isNew(id: string): boolean {
    const now = Date.now();
    for (const [k, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(k);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}

/**
 * A story counts as being about a symbol only when Yahoo says so explicitly.
 * Matching on the headline text instead would let "Reliance on AI grows" through
 * as news about Reliance Industries.
 */
export function isAbout(n: RawNews, symbol: string, yahooSymbol: string): boolean {
  // A video has no body to read and nothing for the triage model to weigh.
  if (n.type === 'VIDEO') return false;
  if (typeof n.title !== 'string' || n.title.trim() === '') return false;
  const tickers = n.relatedTickers ?? [];
  if (tickers.length === 0) return false;
  const want = new Set([symbol.toUpperCase(), yahooSymbol.toUpperCase()]);
  return tickers.some((t) => want.has(t.toUpperCase()));
}

function toItem(n: RawNews, symbol: string): NewsItem {
  const at = n.providerPublishTime;
  return {
    id: n.uuid ?? `${symbol}:${n.title ?? ''}`.slice(0, 120),
    symbol,
    title: (n.title ?? '').trim(),
    publisher: n.publisher ?? 'unknown',
    link: n.link ?? '',
    publishedAt:
      at instanceof Date ? at.toISOString() : typeof at === 'string' ? at : new Date().toISOString(),
    relatedTickers: n.relatedTickers ?? [],
  };
}

/** Newest first, so a triage batch spends its budget on what just happened. */
export function newestFirst(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** Drop anything older than `hours`; stale news is not a trading signal. */
export function withinHours(items: NewsItem[], hours: number, now = Date.now()): NewsItem[] {
  const cutoff = now - hours * 3_600_000;
  return items.filter((i) => {
    const t = Date.parse(i.publishedAt);
    return Number.isNaN(t) ? false : t >= cutoff;
  });
}

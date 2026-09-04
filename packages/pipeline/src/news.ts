import { BaseAgent } from '@aegis/agents';
import { triageNews, newsScore, type TriageItem } from '@aegis/alpha';
import { newestFirst, withinHours, type NewsItem, type YahooNewsSource } from '@aegis/marketdata';
import type { PipelineDeps } from './agents.js';

export const SIG_NEWS = 'news_signal';

export interface NewsDeps extends PipelineDeps {
  news: YahooNewsSource;
  /** Stories older than this are history, not a signal. */
  maxAgeHours?: number;
  /** newsScore above which a story is worth emitting. */
  emitThreshold?: number;
  /** Cap on headlines sent to the model per tick, across all symbols. */
  batchCap?: number;
}

export interface ScoutedStory {
  item: NewsItem;
  triage: TriageItem;
  score: number;
}

/**
 * Reads the news for every symbol in the universe and rates it.
 *
 * This is the only alpha source that works in all three markets. EDGAR covers
 * US filings and nothing else: crypto has no regulator to file with, and Indian
 * results are published to the exchanges rather than to the SEC. Without this
 * agent, the crypto and India universes are watched by nothing at all.
 *
 * One model call per tick, not per headline. Triage over a batch is the whole
 * economic argument for doing it on haiku.
 */
/**
 * Take one item from each list in turn until the cap is reached, so a symbol
 * with forty headlines cannot crowd out a symbol with one.
 */
export function interleave<T>(lists: T[][], cap: number): T[] {
  const out: T[] = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let round = 0; round < depth && out.length < cap; round += 1) {
    for (const list of lists) {
      if (out.length >= cap) break;
      const item = list[round];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

export class NewsScoutAgent extends BaseAgent {
  constructor(private readonly n: NewsDeps) {
    super('news-scout', { intervalMs: 10 * 60 * 1000 }, n);
  }

  override shouldRun(): boolean {
    // Research is the first thing the Budget Governor switches off.
    return this.budget.allows('discretionary');
  }

  async execute(): Promise<void> {
    const fresh = await this.gather();
    if (fresh.length === 0) {
      this.log.event(this.name, `swept ${String(this.n.universe.length)} symbols, no new stories`);
      return;
    }

    const out = await triageNews(
      fresh.map((f) => f.title),
      { budget: this.budget, log: this.log, ...(this.n.ask ? { ask: this.n.ask } : {}) },
    );
    if (!out.ok) {
      this.log.warn(this.name, `triage failed (${out.stage}): ${out.reason}`);
      return;
    }

    const threshold = this.n.emitThreshold ?? 0.45;
    let emitted = 0;
    for (const t of out.items) {
      const item = fresh[t.i];
      if (!item) continue;
      const score = newsScore(t);
      const line = `${item.symbol}  ${t.category}  mat=${String(t.materiality)} dir=${t.direction.toFixed(2)} → ${score.toFixed(2)}`;
      if (score < threshold) {
        this.log.event(this.name, `${line}  (below ${threshold.toFixed(2)}) ${t.why.slice(0, 60)}`);
        continue;
      }
      this.log.ok(this.name, `${line}  ${t.why.slice(0, 80)}`);
      this.bus.emit({
        agent: this.name,
        signalType: SIG_NEWS,
        symbol: item.symbol,
        confidence: Math.round(score * 100),
        data: {
          newsId: item.id,
          title: item.title,
          publisher: item.publisher,
          link: item.link,
          publishedAt: item.publishedAt,
          category: t.category,
          materiality: t.materiality,
          direction: t.direction,
          why: t.why,
        },
      });
      emitted += 1;
    }
    this.log.event(
      this.name,
      `${String(fresh.length)} headlines triaged, ${String(emitted)} above threshold`,
    );
  }

  /**
   * New, recent, relevant headlines across the whole universe.
   *
   * Collected per symbol, then interleaved round-robin before the cap is
   * applied. Draining each symbol in turn looked correct and was not: the US
   * names come first in the universe and are the most heavily covered, so they
   * consumed the entire batch every tick and crypto and India were never
   * looked at. Round-robin gives every symbol its first headline before any
   * symbol gets its second.
   */
  private async gather(): Promise<NewsItem[]> {
    const cap = this.n.batchCap ?? 24;
    const maxAge = this.n.maxAgeHours ?? 36;

    const perSymbol: NewsItem[][] = [];
    for (const entry of this.n.universe) {
      const items = await this.n.news.headlines(entry.symbol, entry.market, 8);
      if (items.length === 0) {
        this.log.event(this.name, `${entry.symbol}: no attributable news`);
        continue;
      }
      const fresh = newestFirst(withinHours(items, maxAge)).filter((i) => this.n.news.isNew(i.id));
      if (fresh.length > 0) perSymbol.push(fresh);
    }
    // With the default cap every symbol gets a slot in the first round. Say so
    // out loud when it does not, rather than silently never looking at the tail
    // of the universe.
    if (perSymbol.length > cap) {
      this.log.warn(
        this.name,
        `${String(perSymbol.length)} symbols have fresh news but the batch cap is ${String(cap)} — ` +
          `${String(perSymbol.length - cap)} will not be looked at this tick`,
      );
    }
    return interleave(perSymbol, cap);
  }
}

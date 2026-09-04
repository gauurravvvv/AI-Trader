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

  /** New, recent, relevant headlines across the whole universe. */
  private async gather(): Promise<NewsItem[]> {
    const cap = this.n.batchCap ?? 24;
    const maxAge = this.n.maxAgeHours ?? 36;
    const out: NewsItem[] = [];
    for (const entry of this.n.universe) {
      if (out.length >= cap) break;
      const items = await this.n.news.headlines(entry.symbol, entry.market, 8);
      if (items.length === 0) {
        this.log.event(this.name, `${entry.symbol}: no attributable news`);
        continue;
      }
      for (const it of newestFirst(withinHours(items, maxAge))) {
        if (out.length >= cap) break;
        if (this.n.news.isNew(it.id)) out.push(it);
      }
    }
    return out;
  }
}

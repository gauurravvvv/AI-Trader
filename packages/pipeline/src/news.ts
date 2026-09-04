import { BaseAgent } from '@aegis/agents';
import { triageNews, newsScore, type TriageItem } from '@aegis/alpha';
import { newestFirst, withinHours, type NewsItem, type YahooNewsSource } from '@aegis/marketdata';
import type { PipelineDeps } from './agents.js';

export const SIG_NEWS = 'news_signal';

/** Stories older than this are forgotten, so the table cannot grow forever. */
const SEEN_RETENTION_DAYS = 14;

export interface NewsDeps extends PipelineDeps {
  news: YahooNewsSource;
  /** Minutes between sweeps. Directly proportional to monthly spend. */
  intervalMinutes?: number;
  /** Stories older than this are history, not a signal. */
  maxAgeHours?: number;
  /** newsScore above which a story is worth emitting. */
  emitThreshold?: number;
  /**
   * Cap on headlines sent to the model per tick, across all symbols.
   *
   * 24 was too many: the reply ran past the output budget and was cut off
   * mid-array. Salvage recovers most of it, but a batch that fits is better
   * than a batch that has to be rescued.
   */
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
    // Cost arithmetic, from a measured tick of $0.0146:
    //   every 10 min -> 144 ticks/day -> ~$63/month, most of a $100 pool
    //   every 20 min ->  72 ticks/day -> ~$31/month, leaving room for the
    //                                    earnings reader and the auditor
    // The tick is free when nothing new has published, so the real figure is
    // lower overnight and at weekends. Tune with NEWS_INTERVAL_MIN.
    super('news-scout', { intervalMs: (n.intervalMinutes ?? 20) * 60 * 1000 }, n);
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
   * Has this story never been offered to the model before?
   *
   * Recorded in the database, not a Map. An in-memory set cannot tell a
   * restart from a new story, so every restart re-triaged everything: one
   * Adobe headline went through thirteen times, at six different scores,
   * because the scorer is not deterministic either. Both the waste and the
   * contradictory data came from the same missing row.
   *
   * INSERT OR IGNORE returns changes=0 when the id is already there, so the
   * check and the claim are one statement and two ticks cannot race.
   */
  private firstSight(newsId: string, symbol: string): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO seen_news (news_id, symbol) VALUES (?, ?)')
      .run(newsId, symbol);
    return r.changes > 0;
  }

  /** Forget old stories so the table stays bounded. */
  private forgetOld(): void {
    this.db
      .prepare(`DELETE FROM seen_news WHERE first_seen < datetime('now', ?)`)
      .run(`-${String(SEEN_RETENTION_DAYS)} days`);
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
    this.forgetOld();
    const cap = this.n.batchCap ?? 14;
    const maxAge = this.n.maxAgeHours ?? 36;

    const perSymbol: NewsItem[][] = [];
    for (const entry of this.n.universe) {
      const items = await this.n.news.headlines(entry.symbol, entry.market, 8);
      if (items.length === 0) {
        this.log.event(this.name, `${entry.symbol}: no attributable news`);
        continue;
      }
      const fresh = newestFirst(withinHours(items, maxAge)).filter((i) => this.firstSight(i.id, i.symbol));
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

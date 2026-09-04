import Decimal from 'decimal.js';
import { BaseAgent } from '@aegis/agents';
import type { Ledger } from '@aegis/ledger';
import type { YahooPriceSource } from '@aegis/marketdata';
import type { OrderRouter } from '@aegis/risk';
import type { ModelId } from '@aegis/claude';
import type { PipelineDeps } from './agents.js';
import { SIG_NEWS } from './news.js';
import { SIG_REGIME, currentRegime, sizeMultiplier, type Regime } from './regime.js';
import {
  proposeThesis, challengeThesis, resolveDebate,
  DEFAULT_DEBATE, type DebateRule, type Evidence, type ThesisDeps,
} from './thesis.js';
import { recordProvenance } from './provenance.js';
import { newsConditions } from './watch.js';

export const SIG_THESIS = 'thesis';

export interface Candidate {
  symbol: string;
  /** Best news score seen for this symbol in the window. */
  score: number;
  /** Signed: positive is bullish news, negative bearish. */
  lean: number;
  headlines: { title: string; publisher: string; publishedAt: string }[];
  signalIds: number[];
}

/**
 * Turn raw news signals into a ranked shortlist.
 *
 * Deterministic, and deliberately so: this decides what the expensive part of
 * the pipeline looks at, and a screen that stops working when credit runs low
 * would leave the analyst reading whatever happened to arrive first.
 *
 * Names already held are dropped here rather than at the end — analysing a
 * position we cannot add to is money spent to reach a foregone conclusion.
 */
export function screen(
  signals: { id: number; symbol: string | null; confidence: number | null; data: Record<string, unknown> }[],
  held: ReadonlySet<string>,
  minScore = 0.35,
): Candidate[] {
  const bySymbol = new Map<string, Candidate>();

  for (const s of signals) {
    const symbol = s.symbol;
    if (symbol === null || held.has(symbol)) continue;
    const score = (s.confidence ?? 0) / 100;
    if (score < minScore) continue;

    const direction = Number(s.data['direction'] ?? 0);
    const title = String(s.data['title'] ?? '');
    if (title === '') continue;

    const existing = bySymbol.get(symbol);
    const entry: Candidate = existing ?? {
      symbol, score: 0, lean: 0, headlines: [], signalIds: [],
    };
    entry.headlines.push({
      title,
      publisher: String(s.data['publisher'] ?? 'unknown'),
      publishedAt: String(s.data['publishedAt'] ?? ''),
    });
    entry.signalIds.push(s.id);
    entry.score = Math.max(entry.score, score);
    // Sum rather than max: three mildly bearish stories are a stronger lean
    // than one, and two opposing stories should partly cancel.
    entry.lean += direction * score;
    bySymbol.set(symbol, entry);
  }

  return [...bySymbol.values()].sort((a, b) => Math.abs(b.lean) - Math.abs(a.lean));
}

export interface SentinelDeps extends PipelineDeps {
  prices: YahooPriceSource;
  ledger: Ledger;
  router: OrderRouter;
  /** Expensive analyses permitted per day. The main cost control. */
  maxAnalysesPerDay?: number;
  /** Fraction of equity per trade before regime and strength scaling. */
  baseSizePct?: number;
  debateRule?: DebateRule;
  minCandidateScore?: number;
  analystModel?: ModelId;
  challengerModel?: ModelId;
}

/**
 * The trading loop: screen, debate, decide, enter.
 *
 * One candidate per tick. Two model calls per candidate and a hard daily cap,
 * because this is the only part of the system that can spend without bound —
 * every other agent is either arithmetic or reads a fixed-size batch.
 */
export class SentinelAgent extends BaseAgent {
  constructor(private readonly cfg: SentinelDeps) {
    super('sentinel', { intervalMs: 3 * 60 * 1000 }, cfg);
  }

  override shouldRun(): boolean {
    if (!this.budget.allows('entry')) return false;
    if (this.analysesToday() >= (this.cfg.maxAnalysesPerDay ?? 12)) return false;
    return this.bus.read([SIG_NEWS], 1).length > 0;
  }

  /** Analyst calls made today. The cap that bounds this agent's spend. */
  private analysesToday(): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) c FROM llm_calls WHERE agent = 'analyst' AND date(created_at) = date('now')`,
      )
      .get() as { c: number };
    return r.c;
  }

  async execute(): Promise<void> {
    const signals = this.bus.read([SIG_NEWS], 30);
    if (signals.length === 0) return;

    const held = new Set(this.cfg.ledger.open(this.cfg.router.venue).map((p) => p.symbol));
    const candidates = screen(signals, held, this.cfg.minCandidateScore ?? 0.35);

    // Consume everything looked at, so the same headline is not re-screened
    // every three minutes for the rest of the day.
    this.bus.consume(signals.map((x) => x.id), this.name);

    if (candidates.length === 0) {
      this.log.event(this.name, `${String(signals.length)} signal(s), nothing worth analysing`);
      return;
    }

    const top = candidates[0]!;
    const others = candidates.length - 1;
    this.log.event(
      this.name,
      `${String(candidates.length)} candidate(s); analysing ${top.symbol} ` +
        `(lean ${top.lean.toFixed(2)}, ${String(top.headlines.length)} headline(s))` +
        (others > 0 ? ` — ${String(others)} deferred to the next tick` : ''),
    );

    await this.evaluate(top);
  }

  private async evaluate(c: Candidate): Promise<void> {
    const quote = await this.cfg.prices.quote(c.symbol);
    if (!quote) {
      this.log.warn(this.name, `${c.symbol}: no quote, cannot evaluate`);
      return;
    }

    const bars = await this.cfg.prices.bars(c.symbol, 8);
    const prevClose = bars.at(-2)?.c ?? bars.at(-1)?.c ?? Number(quote.last);
    const fiveAgo = bars.at(-6)?.c ?? prevClose;
    const last = Number(quote.last);

    const regime: Regime = currentRegime(this.bus.latest([SIG_REGIME], 1));
    const evidence: Evidence = {
      symbol: c.symbol,
      headlines: c.headlines.slice(0, 8),
      movePct: prevClose > 0 ? (last - prevClose) / prevClose : 0,
      move5dPct: fiveAgo > 0 ? (last - fiveAgo) / fiveAgo : 0,
      regime,
    };

    const proposed = await proposeThesis(evidence, this.deps());
    if (!proposed.ok) {
      this.log.warn('analyst', `${c.symbol}: ${proposed.reason}`);
      return;
    }
    const t = proposed.value;
    this.log.event(
      'analyst',
      `${c.symbol}  ${t.direction}  conviction ${String(t.conviction)}  ${String(t.claims.length)} claim(s)  ${t.horizonDays}d`,
    );
    this.log.event('analyst', `  ${t.thesis.slice(0, 150)}`);

    if (t.direction === 'NONE') {
      this.log.event('analyst', `${c.symbol}: declined to take a side — no challenge needed`);
      return;
    }

    const challenged = await challengeThesis(evidence, t, this.deps());
    if (!challenged.ok) {
      // Fail closed: a debate we could not finish is not a debate that was won.
      this.log.warn('challenger', `${c.symbol}: ${challenged.reason} — no trade`);
      return;
    }
    const ch = challenged.value;
    for (const v of ch.claimVerdicts) {
      const mark = v.verdict === 'SUPPORTED' ? '✓' : v.verdict === 'CONTRADICTED' ? '✗' : '?';
      this.log.event('challenger', `  ${mark} ${v.claim.slice(0, 90)}`);
    }
    this.log.event('challenger', `${c.symbol}  ${ch.verdict}  ${ch.oneLine.slice(0, 120)}`);

    const verdict = resolveDebate(t, ch, this.cfg.debateRule ?? DEFAULT_DEBATE);
    this.bus.emit({
      agent: this.name,
      signalType: SIG_THESIS,
      symbol: c.symbol,
      confidence: Math.round(verdict.strength * 100),
      data: {
        direction: t.direction, conviction: t.conviction, thesis: t.thesis,
        verdict: ch.verdict, bearCase: ch.bearCase, traded: verdict.trade,
        reason: verdict.reason,
      },
    });

    if (!verdict.trade) {
      this.log.warn(this.name, `${c.symbol}: no trade — ${verdict.reason}`);
      return;
    }

    await this.enter(c, evidence, verdict.direction!, verdict.strength, regime, quote.last, t, ch);
  }

  /** The two debate calls share this. Forwarding `ask` is what makes the whole
   *  flow testable without a subprocess or a cent of credit. */
  private deps(): ThesisDeps {
    return {
      budget: this.budget,
      log: this.log,
      ...(this.cfg.ask ? { ask: this.cfg.ask } : {}),
      ...(this.cfg.analystModel ? { analystModel: this.cfg.analystModel } : {}),
      ...(this.cfg.challengerModel ? { challengerModel: this.cfg.challengerModel } : {}),
    };
  }

  private async enter(
    c: Candidate,
    e: Evidence,
    direction: 'long' | 'short',
    strength: number,
    regime: Regime,
    price: string,
    t: { thesis: string; invalidators: string[]; horizonDays: number },
    ch: { bearCase: string; oneLine: string },
  ): Promise<void> {
    const side = direction === 'long' ? 'buy' : 'sell';
    const base = this.cfg.baseSizePct ?? 0.03;
    // Three multipliers, each earned: the base allocation, how much of the
    // thesis survived the debate, and what the market as a whole is doing.
    const pct = base * strength * sizeMultiplier(regime, direction);

    const ins = this.db
      .prepare(
        `INSERT INTO decisions (symbol, market, venue, side, audit_score, audit_tier,
                                rationale, thesis_break, source_signal_id, status)
         VALUES (?,?,?,?,?,?,?,?,?, 'APPROVED')`,
      )
      .run(
        c.symbol, 'US', this.cfg.router.venue, side,
        Math.round(strength * 100),
        direction.toUpperCase(),
        `${direction === 'long' ? 'LONG' : 'SHORT'}: ${t.thesis}`.slice(0, 900),
        JSON.stringify(newsConditions(price, direction === 'long' ? 1 : -1)),
        c.signalIds[0] ?? null,
      );
    const decisionId = Number(ins.lastInsertRowid);

    recordProvenance(this.db, decisionId, [
      ...c.headlines.slice(0, 5).map((h) => ({
        kind: 'news' as const, source: h.publisher, reference: h.title.slice(0, 200), asOf: h.publishedAt,
      })),
      { kind: 'quote' as const, source: 'yahoo', reference: c.symbol, asOf: new Date().toISOString() },
    ]);

    if (this.cfg.autonomy === 'SHADOW') {
      this.log.warn(
        'order-router',
        `${c.symbol}: SHADOW — would ${side.toUpperCase()} at ${(pct * 100).toFixed(2)}% of equity, no order placed`,
      );
      return;
    }

    const equity = new Decimal((await this.cfg.router.buildContext()).equity);
    const qty = equity.times(pct).div(price).floor();
    if (qty.lte(0)) {
      this.log.warn('order-router', `${c.symbol}: sized to zero`);
      return;
    }

    const advBars = await this.cfg.prices.bars(c.symbol, 30);
    const adv = advBars.length >= 5
      ? String(Math.round(advBars.reduce((a, b) => a + b.v, 0) / advBars.length))
      : null;

    const res = await this.cfg.router.route(
      { decisionId, symbol: c.symbol, side, qty: qty.toString(), price, intent: 'open', allowResize: true },
      adv,
    );
    if (res.ok) {
      this.log.ok(
        'order-router',
        `${c.symbol} ${side.toUpperCase()} ${res.qty} @ ~${Number(price).toFixed(2)} ` +
          `(${(pct * 100).toFixed(2)}% of equity, ${regime}) → order ${String(res.orderId)}`,
      );
      this.cfg.notify?.({
        kind: 'ORDER_SUBMITTED',
        subject: `Aegis: ${direction.toUpperCase()} ${c.symbol} — ${res.qty} @ ~${Number(price).toFixed(2)}`,
        body: [
          `${side.toUpperCase()} ${res.qty} ${c.symbol} @ ~${Number(price).toFixed(2)}`,
          `Size:    ${(pct * 100).toFixed(2)}% of equity   ·   market ${regime}`,
          '',
          'Thesis:', t.thesis,
          '',
          'The case against:', ch.bearCase,
          '',
          `Challenger: ${ch.oneLine}`,
          '',
          'This is wrong if:',
          ...t.invalidators.map((i) => `  • ${i}`),
          '',
          'Headlines it was built on:',
          ...e.headlines.slice(0, 5).map((h) => `  • ${h.title} (${h.publisher})`),
        ].join('\n'),
      });
    } else {
      this.log.warn('order-router', `${c.symbol} rejected: ${res.reason}`);
    }
  }
}

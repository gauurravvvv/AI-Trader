import Decimal from 'decimal.js';
import { BaseAgent, type AgentDeps } from '@aegis/agents';
import type { AskFn } from '@aegis/claude';
import type { EdgarClient } from '@aegis/edgar';
import { trimFiling } from '@aegis/edgar';
import type { YahooConsensus, YahooPriceSource } from '@aegis/marketdata';
import { standardisedSue } from '@aegis/marketdata';
import { readEarnings, scoreSue } from '@aegis/alpha';
import type { OrderRouter } from '@aegis/risk';
import { auditDecision } from './auditor.js';
import { edgarWatchable, type UniverseEntry } from './universe.js';

export interface PipelineDeps extends AgentDeps {
  edgar: EdgarClient;
  consensus: YahooConsensus;
  prices: YahooPriceSource;
  router: OrderRouter;
  universe: UniverseEntry[];
  sueThreshold: number;
  auditFloor: number;
  /** SHADOW logs the decision and places nothing. */
  autonomy: 'SHADOW' | 'AUTO';
  /** Defaults to the real Claude CLI. Overridden in tests. */
  ask?: AskFn;
  /** Optional. Structurally typed so the pipeline need not import @aegis/notify. */
  notify?: (n: { kind: NotifyLike; subject: string; body: string }) => void;
}

export type NotifyLike =
  | 'ORDER_SUBMITTED'
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED'
  | 'POSITION_EXITED'
  | 'RISK_BREACH'
  | 'BUDGET_TIER'
  | 'DAILY_SUMMARY';

const SIG_FILING = 'filing_8k';
const SIG_SCORED = 'earnings_scored';

/**
 * Watches EDGAR for new earnings 8-Ks across the universe.
 *
 * Keeps a per-CIK cursor so a filing is read exactly once. Without it a restart
 * would re-read — and re-pay for — every filing in the recent window.
 */
export class EdgarPollerAgent extends BaseAgent {
  private readonly seen = new Set<string>();

  constructor(private readonly p: PipelineDeps) {
    super('edgar-poller', { intervalMs: 5 * 60 * 1000 }, p);
    // Seed from the database so a restart does not replay history.
    const rows = this.db
      .prepare(`SELECT data FROM agent_signals WHERE signal_type = ?`)
      .all(SIG_FILING) as { data: string }[];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data) as { accessionNo?: string };
        if (d.accessionNo !== undefined) this.seen.add(d.accessionNo);
      } catch {
        /* ignore malformed */
      }
    }
  }

  async execute(): Promise<void> {
    const watch = edgarWatchable(this.p.universe);
    let found = 0;
    for (const entry of watch) {
      const filings = await this.p.edgar.recentEarnings8K(entry.cik);
      const fresh = filings.filter((f) => !this.seen.has(f.accessionNo)).slice(0, 1);
      for (const f of fresh) {
        this.seen.add(f.accessionNo);
        this.bus.emit({
          agent: this.name,
          signalType: SIG_FILING,
          symbol: entry.symbol,
          data: { cik: f.cik, accessionNo: f.accessionNo, filedAt: f.filedAt },
        });
        this.log.event(this.name, `8-K ${entry.symbol}  ${f.accessionNo}  ${f.filedAt.slice(0, 16)}`);
        found += 1;
      }
    }
    if (found === 0) this.log.event(this.name, `swept ${String(watch.length)} filers, nothing new`);
  }

  protected override async onWake(): Promise<void> {
    this.p.prices.clear();
  }
}

/**
 * Reads a new filing, scores it, and — if it clears every gate — proposes a trade.
 *
 * This agent spends the money, so it is gated at every step: budget tier,
 * consensus availability, the SUE threshold, the Auditor's confidence floor,
 * and finally the deterministic Risk Officer inside the router.
 */
export class EarningsReaderAgent extends BaseAgent {
  constructor(private readonly p: PipelineDeps) {
    super('earnings-reader', { intervalMs: 60 * 1000 }, p);
  }

  override shouldRun(): boolean {
    return this.bus.read([SIG_FILING], 1).length > 0;
  }

  async execute(): Promise<void> {
    const signals = this.bus.read([SIG_FILING], 3);
    for (const sig of signals) {
      const symbol = sig.symbol ?? '?';
      const d = sig.data as { cik: string; accessionNo: string; filedAt: string };
      this.bus.consume([sig.id], this.name);

      const raw = await this.p.edgar.earningsExhibit(d.cik, d.accessionNo);
      if (raw === null) {
        this.log.warn(this.name, `${symbol}: no EX-99.1 in ${d.accessionNo}`);
        continue;
      }
      const text = trimFiling(raw);

      // Numeric surprise from consensus — the filing never states it.
      const cons = await this.p.consensus.get(symbol);
      let numericSue: number | null = null;
      const last = cons?.history.at(-1);
      if (cons && last) {
        const st = standardisedSue(last.epsActual, last.epsEstimate, cons.history.slice(0, -1));
        numericSue = st.sue;
        this.log.event(
          'consensus',
          `${symbol} EPS ${String(last.epsActual)} vs est ${last.epsEstimate.toFixed(2)} → ${st.sue.toFixed(2)}σ (${st.basis})`,
        );
      } else {
        this.log.warn('consensus', `${symbol}: no consensus history`);
      }

      const out = await readEarnings(text, {
        budget: this.budget,
        log: this.log,
        ...(this.p.ask ? { ask: this.p.ask } : {}),
      });
      if (!out.ok) {
        this.log.warn(this.name, `${symbol}: read failed (${out.stage}) ${out.reason}`);
        continue;
      }
      const read = out.read;
      this.log.event(
        this.name,
        `${symbol}  guidance=${read.guidanceDelta} momentum=${String(read.momentumShift)} tone=${String(read.languageTone)} hedge=${String(read.hedgingDensity)} conf=${String(read.confidence)}`,
      );
      if (read.riskFlags.length > 0) {
        this.log.warn(this.name, `${symbol} risk: ${read.riskFlags.map((f) => f.slice(0, 70)).join(' | ')}`);
      }

      const score = scoreSue({ read, numericSue }, this.p.sueThreshold);
      this.log.event(
        'surprise-scorer',
        `${symbol}  SUE ${score.sue} → ${score.passesGate ? 'PASSES' : 'below'} gate (>=${score.passesGate ? '' : ''}${this.p.sueThreshold.toFixed(2)})`,
      );
      for (const pen of score.penalties) this.log.warn('surprise-scorer', `${symbol}: ${pen}`);

      if (!score.passesGate) continue;

      const audit = await auditDecision(symbol, read, score, numericSue, {
        budget: this.budget,
        log: this.log,
        floor: this.p.auditFloor,
        ...(this.p.ask ? { ask: this.p.ask } : {}),
      });
      if (!audit.ok) {
        // Fail closed: an audit we could not complete is not an audit that passed.
        this.log.warn('thesis-auditor', `${symbol}: ${audit.reason} — no order`);
        continue;
      }
      const a = audit.audit;
      this.log.event(
        'thesis-auditor',
        `${symbol}  ${String(a.total)}/100 ${a.tier}  ${a.verdict}  — ${a.oneLineJudgement.slice(0, 110)}`,
      );
      for (const rf of a.redFlags) this.log.error('thesis-auditor', `${symbol} RED FLAG: ${rf}`);
      if (!a.passesFloor) {
        this.log.warn('thesis-auditor', `${symbol}: below floor ${String(this.p.auditFloor)} — no order`);
        continue;
      }

      this.bus.emit({
        agent: this.name,
        signalType: SIG_SCORED,
        symbol,
        confidence: a.total,
        data: { sue: score.sue, audit: a.total, tier: a.tier, why: read.oneLineWhy },
      });

      await this.propose(symbol, score.sue, a.total, a.tier, read.oneLineWhy, sig.id);
    }
  }

  private async propose(
    symbol: string,
    sue: string,
    auditScore: number,
    tier: string,
    why: string,
    /** INV-2: every decision traces back to the filing signal that caused it. */
    sourceSignalId: number,
  ): Promise<void> {
    const quote = await this.p.prices.quote(symbol);
    if (!quote) {
      this.log.warn(this.name, `${symbol}: no quote, cannot size`);
      return;
    }

    const ins = this.db
      .prepare(
        `INSERT INTO decisions (symbol, market, venue, side, sue_score, audit_score, audit_tier,
                                rationale, thesis_break, source_signal_id, status)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'APPROVED')`,
      )
      .run(
        symbol,
        'US',
        'alpaca-paper',
        'buy',
        sue,
        auditScore,
        tier,
        why,
        JSON.stringify([
          'guidance is lowered or withdrawn at the next report',
          'price closes below the entry stop',
          'a restatement or auditor change is disclosed',
        ]),
        sourceSignalId,
      );
    const decisionId = Number(ins.lastInsertRowid);

    if (this.p.autonomy === 'SHADOW') {
      this.log.warn(
        'order-router',
        `${symbol}: SHADOW mode — decision ${String(decisionId)} logged, no order placed`,
      );
      return;
    }

    // Size to 3% of equity, then let the Risk Officer resize or refuse.
    const acctEquity = new Decimal((await this.p.router.buildContext()).equity);
    const qty = acctEquity.times(0.03).div(quote.last).floor();
    if (qty.lte(0)) {
      this.log.warn('order-router', `${symbol}: sized to zero`);
      return;
    }

    const advBars = await this.p.prices.bars(symbol, 30);
    const adv =
      advBars.length >= 5
        ? String(Math.round(advBars.reduce((a, b) => a + b.v, 0) / advBars.length))
        : null;

    const res = await this.p.router.route(
      { decisionId, symbol, side: 'buy', qty: qty.toString(), price: quote.last, allowResize: true },
      adv,
    );
    if (res.ok) {
      this.log.ok(
        'order-router',
        `${symbol} BUY ${res.qty} @ ~${Number(quote.last).toFixed(2)}${res.resized ? ' (resized)' : ''} → order ${String(res.orderId)}`,
      );
    } else {
      this.log.warn('order-router', `${symbol} rejected: ${res.reason}`);
    }
  }
}

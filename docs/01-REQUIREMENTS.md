# 01 — Requirements Specification

> ### ⚠️ Partially superseded — 2026-09-03
> The authoritative design is now **[`docs/superpowers/specs/2026-09-03-aegis-design.md`](superpowers/specs/2026-09-03-aegis-design.md)**.
>
> **What changed:** the runtime is the local **`claude -p` CLI**, not the Anthropic API with a key
> (and it is metered — $100/mo credit pool, not $300/mo of API spend); storage is **SQLite**, not
> Postgres+Redis; the agent roster is **rules-first with 5 model-using agents**, not 12 LLM calls per
> cycle; the primary strategy is **text-based post-earnings drift**, not generic multi-dimension
> scoring; market order is **US → Crypto → India**.
>
> **What still holds, and is not repeated in the spec:** the eight hard invariants (§ 3), the functional requirements for notification, dashboard and evaluation (§ 5.6–5.8), the `BrokerAdapter` abstraction and the India/SEBI reasoning (§ 6), the fill and slippage model (§ 9.4), security and compliance (§ 10), and the acceptance criteria (§ 11).

**Project:** Aegis — multi-agent, real-time, paper-trading research platform
**Date:** 2026-09-03
**Status:** Draft for approval
**Evidence base:** [00-RESEARCH-BRIEF.md](00-RESEARCH-BRIEF.md)
**Agent detail:** [02-AGENT-ARCHITECTURE.md](02-AGENT-ARCHITECTURE.md)
**Delivery plan:** [03-ROADMAP.md](03-ROADMAP.md)

---

## 1. One-paragraph summary

Aegis is a self-hosted platform where a team of Claude-powered agents continuously
researches US equities, Indian equities, and crypto; debates each idea from a bull
and a bear side; audits its own reasoning; sizes and schedules an execution plan;
passes it through a deterministic risk gate; and places the resulting orders
against **paper-money accounts only**. Every trade action emails the operator. A
live web dashboard shows TradingView charts alongside the agents' reasoning, open
positions, and a running performance comparison against buy-and-hold. The system
is built to *measure whether the agents actually add value* — not to assume it.

---

## 2. Goals, non-goals, and the honest caveat

### 2.1 Goals

| # | Goal |
|---|---|
| G1 | Run a full research → decision → execution → monitoring loop autonomously, in real time, across three markets |
| G2 | Make every order traceable to the exact reasoning chain and data snapshot that produced it |
| G3 | Notify the operator by email on every trade action, within 60 seconds of the fill |
| G4 | Show live market charts (TradingView) and our own fills/equity curve side by side |
| G5 | Continuously measure the strategy against buy-and-hold and a random-entry control, after modelled costs |
| G6 | Keep the architecture ready for a real-money adapter without ever shipping one in v1 |

### 2.2 Non-goals for v1

Real-money trading. Options/futures **execution** (options *analysis* is in scope
as a signal). Margin or leverage. Sub-second / HFT strategies. Tax filing or
statutory reporting. Multi-tenant SaaS — this is single-operator, self-hosted.

### 2.3 The honest caveat — read this before approving

The brief says "maximise the profits." **No design can promise that, and a design
that assumes it is the design that loses money.** Three things are true and are
baked into these requirements:

1. **LLM agents have no demonstrated edge in liquid markets.** Neither vendored
   toolkit, nor TradingAgents, nor ai-hedge-fund publishes an audited live track
   record. Every one of them carries a research-only disclaimer.
2. **Paper trading systematically overstates results.** No queue position, no
   partial-fill reality, no market impact, and — for our free Alpaca tier — IEX
   prices rather than consolidated SIP. We model slippage and commission
   explicitly (§ 9.4) so the gap is visible rather than flattering.
3. **The output of v1 is a verdict, not a bankroll.** Success is a defensible
   answer to "does this beat the benchmark after costs, and is the sample large
   enough to believe?" If the answer is no, that is a successful project.

Everything below is designed to make that verdict trustworthy.

---

## 3. Hard invariants (non-negotiable, test-enforced)

These are not features; they are properties the codebase must be unable to violate.

| ID | Invariant | How it is enforced |
|---|---|---|
| **INV-1** | **Paper money only.** There is no code path to a funded account. | `TRADING_MODE` env var accepts only the literal `paper`; any other value throws at boot. Every `BrokerAdapter` is constructed from a frozen `PAPER_ENDPOINTS` allowlist — the live host strings do not appear anywhere in the repo. A unit test greps the built bundle for live hostnames and fails if any is present. |
| **INV-2** | **No order without a full decision lineage.** | `Order.decisionId` is `NOT NULL` with a foreign key to `Decision`. The order router rejects any order lacking a resolvable lineage. |
| **INV-3** | **No order below the Auditor's confidence floor.** | The Auditor's 0–100 score is a required field on `Decision`; the router refuses `score < AUDIT_FLOOR` (default 70). |
| **INV-4** | **Risk limits are deterministic code, never an LLM judgement.** | The Risk Officer module contains zero LLM calls. It is pure functions with property-based tests. An LLM may *advise*; only this module *decides*. |
| **INV-5** | **Every numeric fact carries provenance.** | Every quote/fundamental/news item in a `ContextPacket` has `{source, retrievedAt, confidence}`. `confidence: "model_memory"` is rejected as an input to any order-producing agent. |
| **INV-6** | **The kill switch is honoured within one tick.** | A global `HALT` flag is checked by the router immediately before every send, and by the scheduler before every cycle. Setting it cancels all open orders and blocks new ones. Tested. |
| **INV-7** | **Every trade action emails the operator.** | Order submit / fill / partial-fill / reject / cancel each enqueue a notification transactionally with the state change (outbox pattern). A failed send retries; it never silently drops. |
| **INV-8** | **No fabricated numbers.** | Agents receive data only via tool results. Structured-output schemas make every numeric field either a real value or explicitly `null` with a `dataGap` reason. Prose-only agents are not permitted to emit numbers used downstream. |

---

## 4. Actors

| Actor | Description |
|---|---|
| **Operator** (you) | Single human user. Sets universe, risk budget, autonomy level. Receives emails. Can halt everything. |
| **Agent tier** | Claude-powered research/planning agents (§ [02](02-AGENT-ARCHITECTURE.md)) |
| **Deterministic tier** | Risk Officer, Order Router, Position Ledger, Evaluator — plain code |
| **Venues** | Alpaca paper (US equities + crypto), Binance Spot Testnet (crypto), India Simulator (NSE/BSE) |
| **Notifier** | Resend (email) |

---

## 5. Functional requirements

### 5.1 Universe & scheduling

| ID | Requirement |
|---|---|
| FR-1.1 | Operator defines a **watch universe** per market: explicit tickers, and/or a screen (e.g. "NSE Nifty 100", "S&P 500 tech", "top 20 crypto by volume"). Max 150 symbols total in v1. |
| FR-1.2 | The scheduler triggers research cycles on: **market-open scan** (per-market local time), **fixed intra-session interval** (default 30 min), **event triggers** (earnings date, ±5% intraday move, volume > 3× ADV, breaking news match), and **watch conditions** raised by the Monitor (§ 5.5). |
| FR-1.3 | Each market has an independent session calendar. US: 09:30–16:00 ET + pre/post flags. India: 09:15–15:30 IST, NSE holiday calendar. Crypto: 24/7. |
| FR-1.4 | A cycle for a symbol is **debounced** — no more than one full research cycle per symbol per 15 minutes unless a hard event trigger fires. |
| FR-1.5 | Cycles are **idempotent and resumable**. A crash mid-cycle resumes from the last completed stage (checkpoint per stage, per TradingAgents' `checkpoint_enabled`). |

### 5.2 Research

| ID | Requirement |
|---|---|
| FR-2.1 | Build one **ContextPacket** per symbol per cycle: quote, OHLCV (multi-timeframe), indicators (MA 20/50/200, RSI-14, MACD, ATR-14, ADX-14, Bollinger), fundamentals, recent news, analyst consensus where available, and market-regime context. Built once, shared by all analysts. |
| FR-2.2 | Five analysts run **in parallel** against the same packet: Technical, Fundamental, Sentiment, News/Catalyst, Macro/Regime. Each returns a schema-validated report with five 0–20 sub-scores and a 0–100 dimension score. |
| FR-2.3 | Analyst rubrics are **versioned config**, not hard-coded prose, so a rubric change is a reviewable diff and every stored report records `rubricVersion`. |
| FR-2.4 | For Indian symbols the Fundamental analyst uses INR-native metrics and Indian disclosure sources; for crypto it is replaced by an **On-chain/Tokenomics** analyst (supply schedule, holder concentration, exchange flows, funding rate). |
| FR-2.5 | If a data source is unavailable, the affected sub-score is recorded as `null` with a `dataGap` reason and the dimension is scored conservatively — never silently defaulted to neutral without a flag. |

### 5.3 Planning & decision

| ID | Requirement |
|---|---|
| FR-3.1 | **Bull vs Bear debate**: two researchers alternate for `maxDebateRounds` (default 2 → 4 turns), each seeing the analyst reports and the opponent's prior turn. Terminates on round cap or explicit convergence. |
| FR-3.2 | **Risk trio debate**: Aggressive / Conservative / Neutral risk debaters rotate for `maxRiskRounds` (default 1 → 3 turns), arguing sizing rather than direction. |
| FR-3.3 | **Auditor** scores the whole chain 0–100 across Data Quality, Methodology, Signal Consistency, Risk Coverage, Reasoning Transparency (20 each) and may downgrade or reverse the signal. Below `AUDIT_FLOOR` the cycle ends with no order (INV-3). |
| FR-3.4 | **Conflict resolution** is explicit and coded: fundamental overrides technical; 4-of-5 consensus overrides an outlier; deeply contradictory → `CONFLICTED_MONITOR_ONLY`, no order. |
| FR-3.5 | **Execution Planner** produces a staged plan: entry rungs (spacing 1.0–1.5 × ATR-14, equal-dollar sizing), share floor and ceiling, stop level, targets, time stop, and the **thesis-break conditions**. It refuses to plan for the do-not-ladder list (leveraged/inverse ETFs, binary-event names, solvency-risk names). |
| FR-3.6 | **Portfolio Manager** makes the final call with cross-position and cross-market context: approve / resize / reject, with a written rationale. It is the only agent that sees the whole book. |
| FR-3.7 | Every decision is persisted with its full lineage before any order is created. |

### 5.4 Execution

| ID | Requirement |
|---|---|
| FR-4.1 | The **Risk Officer** (deterministic) evaluates every proposed order against: per-position cap, per-sector cap, per-market cap, gross exposure cap, daily-loss stop, max open positions, min liquidity (ADV %), symbol blocklist, duplicate-order guard, and the global HALT flag. Reject reasons are enumerated and logged. |
| FR-4.2 | The **Order Router** translates an approved order into a venue-specific request via the `BrokerAdapter` interface and records the venue's order ID. |
| FR-4.3 | Supported order types v1: market, limit, stop, stop-limit, bracket (entry + take-profit + stop) where the venue supports it. Ladder rungs are placed as resting limit orders where possible, else managed by the scheduler. |
| FR-4.4 | Fills arrive by **WebSocket** where the venue provides one (Alpaca `trade_updates`, CCXT `watchOrders`), with a REST reconciliation sweep every 60 s as backstop. The ledger is the source of truth and is reconciled against the venue on every sweep; divergence raises a `RECONCILIATION_BREAK` alert and halts new orders for that venue. |
| FR-4.5 | An **autonomy level** per market: `AUTO` (place immediately), `CONFIRM` (email with approve/reject links, expires in N minutes), `SHADOW` (log the decision, place nothing). Default `SHADOW` for the first two weeks of any new market. |

### 5.5 Monitoring

| ID | Requirement |
|---|---|
| FR-5.1 | Every open position carries active **watch conditions** derived from its thesis: price ±X%, stop touched, target touched, next earnings date, ADX regime flip, thesis-break clauses, and a time stop. Directly modelled on InvestSkill's `Thesis Invalidation` / `Re-run when` blocks. |
| FR-5.2 | The Monitor evaluates watch conditions on every tick for price-based ones and on a 5-minute cadence for the rest. A fired condition re-triggers a research cycle with the condition as the reason. |
| FR-5.3 | Position state, unrealised/realised P&L, blended average cost, and lot detail are recomputed on every fill. |
| FR-5.4 | A **reflection** runs when a position closes (or at 30-day marks for open ones): a cheap model writes 2–4 sentences citing raw return **and alpha vs the market benchmark**, stored in the decision log and injected into future cycles for that symbol. (Adopted from `TradingAgents/graph/reflection.py`.) |

### 5.6 Notification

| ID | Requirement |
|---|---|
| FR-6.1 | Email on: order submitted, filled, partially filled, rejected, cancelled; stop/target hit; thesis break; risk-limit breach; reconciliation break; daily summary; kill switch engaged. |
| FR-6.2 | Trade emails include: action, symbol, market, qty, price, order type, position after, conviction score, Auditor confidence, the PM's one-paragraph rationale, the thesis-break conditions, and a deep link to the full decision lineage. |
| FR-6.3 | Delivery is transactional (outbox pattern) with retry and dead-letter. A send failure never blocks or reverses a trade, but is surfaced on the dashboard. |
| FR-6.4 | Rate-limiting/digest: more than 10 events in 5 minutes collapse into one digest email, except rejections, risk breaches, and kill-switch events which always send individually. |
| FR-6.5 | Every email carries a plain-text paper-trading disclaimer and a one-click halt link. |

### 5.7 Dashboard

| ID | Requirement |
|---|---|
| FR-7.1 | **Live market charts via TradingView widgets** — Advanced Chart (per symbol), Ticker Tape (universe), Technical Analysis gauge, Market Overview, and a heatmap per market. Embedded as web components. |
| FR-7.2 | **Our own overlays via Lightweight Charts** — equity curve, drawdown, entry/exit markers, ladder rungs, stop and target lines. TradingView widgets cannot render our fills, so this is a second, deliberate chart layer. |
| FR-7.3 | Positions table (live P&L), open orders, decision feed with expandable reasoning, agent-run inspector (per-stage inputs/outputs/tokens/cost/latency), and the evaluation panel (§ 5.8). |
| FR-7.4 | Live updates by WebSocket/SSE — no polling for price or position state. |
| FR-7.5 | A permanently visible **PAPER TRADING** banner and a kill-switch button in the header. |

### 5.8 Evaluation

| ID | Requirement |
|---|---|
| FR-8.1 | Track per market and overall: total return, CAGR, max drawdown, Sharpe, Sortino, hit rate, average win/loss, profit factor, turnover, and modelled cost drag. |
| FR-8.2 | Benchmark against **buy-and-hold of the same universe**, the market index (SPY / NIFTY 50 / BTC), and a **random-entry control** with matched trade count and holding period. |
| FR-8.3 | Attribution: contribution by market, by agent-dimension score bucket, and by Auditor confidence tier — so we can see whether high-confidence decisions actually outperform low-confidence ones. That single chart is the project's core scientific output. |
| FR-8.4 | Report sample adequacy: number of closed trades and a naive significance check. Refuse to claim edge below 100 closed trades. |

---

## 6. Markets & venues

### 6.1 Common abstraction

```ts
interface BrokerAdapter {
  readonly venue: VenueId;              // 'alpaca-paper' | 'binance-testnet' | 'india-sim'
  readonly market: MarketId;            // 'US' | 'IN' | 'CRYPTO'
  readonly mode: 'paper';               // INV-1: the type has no other member

  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  submitOrder(req: OrderRequest): Promise<VenueOrder>;
  cancelOrder(venueOrderId: string): Promise<void>;
  listOpenOrders(): Promise<VenueOrder[]>;

  streamFills(onEvent: (e: FillEvent) => void): Unsubscribe;
  reconcile(): Promise<ReconciliationReport>;

  readonly calendar: SessionCalendar;
  readonly constraints: VenueConstraints; // tick size, lot size, min notional, shortable, fractional
}
```

Agent code never imports a concrete adapter. Adding a venue is one file plus a
conformance-test run against the shared adapter test suite.

### 6.2 US equities + crypto — Alpaca Paper

- Endpoint `https://paper-api.alpaca.markets`. Free, real-time, open to anyone globally with an email — no funding, no US residency.
- Market data + WebSocket streaming; `trade_updates` is our fill source.
- **Known limitation, must be surfaced in the UI:** the free paper tier is **IEX**, a single exchange, not consolidated SIP. Prices will diverge from the true NBBO. The Evaluator applies an extra slippage penalty for US fills to compensate.
- Alpaca also covers crypto, giving us a second crypto venue for cross-checking simulator realism.

### 6.3 India — simulator first (decision, with reasoning)

**Finding:** no mainstream Indian broker exposes a true paper-trading sandbox on
its order API, and since **2026-04-01 the full SEBI algo framework is in force**:
static-IP whitelisting is mandatory, every strategy needs a registered unique
Strategy ID, algo providers must empanel with the exchange and pass broker due
diligence, OAuth + 2FA is required, and API sessions must auto-logout before the
next pre-open.

**Decision:** India ships on **our own deterministic simulator** in v1 —
`india-sim` — fed by real NSE/BSE market data, implementing the same
`BrokerAdapter` interface, with an explicit fill model (see § 9.4). A real broker
adapter (Zerodha Kite / Dhan / Fyers) is a later, separately-scoped compliance
workstream.

**Why this is the right call, not a shortcut:** connecting a real Indian broker
API would be a compliance project (static IP infrastructure, exchange empanelment,
broker due diligence) that delivers *no additional signal quality* for a
paper-money research system. The simulator gives us identical agent behaviour and
identical evaluation, at zero regulatory surface. If the strategy proves out, the
compliance work becomes justified — and the adapter interface means it is a
drop-in.

**Optional:** OpenAlgo (AGPL) can be run as a **separate self-hosted service**
reachable over HTTP if we later want a real broker bridge without writing 30
adapters. Arm's-length process only — never linked (see `reference/MANIFEST.md`).

### 6.4 Crypto — Binance Spot Testnet via CCXT

- `exchange.setSandboxMode(true)` immediately after construction, before any other call.
- CCXT gives WebSocket `watchTicker` / `watchOHLCV` / `watchOrders` and a unified order API across 100+ exchanges, so adding a second crypto venue later is trivial.
- 24/7 with no session boundary — this is the best venue to prove the real-time loop, so **crypto is the first market we ship** (see [03-ROADMAP.md](03-ROADMAP.md)).

### 6.5 Market data sources

| Market | Primary | Backup | Notes |
|---|---|---|---|
| US | Alpaca market data (IEX on free tier) | Yahoo Finance | Disclose IEX vs SIP |
| India | Broker/vendor REST + WS; free tier via Yahoo-backed NSE/BSE wrappers or Twelve Data | ICICI Breeze (free API access) | Verify licence terms before commercial use |
| Crypto | Binance WS via CCXT | Any second CCXT exchange | 24/7 |
| Macro | FRED (US), RBI/MoSPI (India) | — | Cached daily |
| News | Provider TBD in Phase 3 | — | Must supply timestamps for provenance |

---

## 7. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Fill event → email delivered | p95 < 60 s |
| NFR-2 | Fill event → dashboard update | p95 < 2 s |
| NFR-3 | Full research cycle (5 analysts + debate + audit + plan + PM) | p50 < 3 min, p95 < 8 min |
| NFR-4 | Risk Officer evaluation | < 50 ms, synchronous, no I/O |
| NFR-5 | LLM cost per full research cycle | budget < $0.60 (see § 9.5); hard monthly cap with auto-halt |
| NFR-6 | Uptime during market hours | 99% (single-node self-hosted is acceptable in v1) |
| NFR-7 | Crash recovery | resume mid-cycle from last checkpoint; no duplicate orders after restart |
| NFR-8 | Observability | structured logs, per-stage traces, token/cost/latency per agent call, all queryable from the dashboard |
| NFR-9 | Secrets | never in repo; `.env` gitignored; adapters read from env only; a pre-commit secret scan runs in CI |
| NFR-10 | Reproducibility | `temperature: 0` on decision agents; every run records model ID, prompt version, rubric version, and packet hash |

---

## 8. Data model (core entities)

```
Universe        id, market, symbols[], screenDef?, active
Cycle           id, symbol, market, triggerReason, startedAt, endedAt, status, checkpoint
ContextPacket   id, cycleId, asOf, payload(jsonb), sources[], contentHash
AnalystReport   id, cycleId, dimension, score0_100, subScores[5], findings, rubricVersion,
                modelId, promptVersion, tokensIn, tokensOut, costUsd, latencyMs, dataGaps[]
DebateTurn      id, cycleId, kind('research'|'risk'), speaker, round, content, structured
Decision        id, cycleId, convictionScore, grade, signal, auditScore, auditTier,
                auditFlags[], conflictStatus, pmRationale, thesis, thesisBreakConditions[]
ExecutionPlan   id, decisionId, rungs[], floorQty, ceilingQty, stop, targets[], timeStop,
                ladderSuitability, presetName
RiskEvaluation  id, decisionId, checks[], passed, rejectReasons[], evaluatedAt
Order           id, decisionId(FK, NOT NULL), venue, venueOrderId, symbol, side, type,
                qty, limitPrice, stopPrice, status, submittedAt, rungIndex?
Fill            id, orderId, qty, price, fee, filledAt, venueFillId
Position        id, venue, symbol, qty, avgCost, lots[], openedAt, closedAt, realisedPnl
WatchCondition  id, positionId, kind, params(jsonb), active, firedAt, firedReason
Notification    id, kind, payload, status, attempts, sentAt, providerMessageId
Reflection      id, positionId, rawReturn, alphaReturn, benchmark, text, createdAt
EvalSnapshot    id, asOf, market, metrics(jsonb), benchmarks(jsonb)
```

`Decision → Cycle → ContextPacket` plus `AnalystReport[]` and `DebateTurn[]` is
the lineage required by INV-2. `ContextPacket.contentHash` makes a cycle replayable.

---

## 9. Key design decisions

> Each is a decision made on the evidence in [00](00-RESEARCH-BRIEF.md), stated so
> it can be overridden. Where the brief was silent, the assumption is marked
> **[ASSUMPTION]** — flag any you disagree with and the plan adjusts.

### 9.1 Stack — TypeScript monorepo **[ASSUMPTION]**

pnpm workspaces. `apps/web` (Next.js 15, App Router) · `apps/worker` (Node, the
agent runtime + scheduler) · `packages/agents` · `packages/brokers` ·
`packages/risk` · `packages/data` · `packages/db` (Drizzle + Postgres) ·
`packages/notify`.

**Why one language:** TradingView and Lightweight Charts are browser-side; the
Anthropic TS SDK is first-class; a single type system across the order/decision
contracts eliminates a whole class of integration bug. Python would be preferable
for heavy backtesting — deferred to a later phase as a separate service if needed
(YAGNI).

**Storage:** Postgres (relational lineage, `jsonb` for packets) + Redis (stream
fan-out, debounce keys, locks).

### 9.2 Agent runtime — Claude API with the SDK Tool Runner

Not the Claude Agent SDK (that is a coding/filesystem harness — wrong shape). Not
Managed Agents in v1 (we need our own low-latency loop and our own hard risk gate
in-process).

**Tool Runner is the right fit specifically because of its per-turn hooks** — the
approval gate, error interception, and result modification we need for a risk
gate are exactly what those hooks provide, without hand-writing the loop.

*Managed Agents scheduled deployments are a genuinely attractive fit for the
nightly deep-research pass* — revisit in Phase 6 for that one job only.

### 9.3 Models and effort

| Agent | Model | Thinking / effort | Rationale |
|---|---|---|---|
| Technical, Sentiment, News, Macro analysts | `claude-haiku-4-5` | default | High frequency, rubric-bounded, cheap |
| Fundamental / On-chain analyst | `claude-opus-5` | adaptive, `effort: medium` | Reads filings; needs reasoning depth |
| Bull / Bear researchers | `claude-opus-5` | adaptive, `effort: high` | Debate quality is the product |
| Risk trio | `claude-opus-5` | adaptive, `effort: medium` | — |
| **Auditor** | `claude-opus-5` | adaptive, `effort: xhigh` | The gate. Most expensive, least frequent, highest stakes |
| Execution Planner | `claude-opus-5` | adaptive, `effort: high` | Arithmetic-heavy; must be right |
| **Portfolio Manager** | `claude-opus-5` | adaptive, `effort: xhigh` | Final authority, sees the whole book |
| Reflection | `claude-haiku-4-5` | default | 2–4 sentences, post-hoc |

All decision agents run `temperature: 0` for reproducibility (NFR-10) and use
`output_config.format` structured outputs — never prose parsing. Prompt caching
(`cache_control`) on the shared ContextPacket so five analysts pay for it once.

### 9.4 Fill model for the India simulator (and slippage for all venues)

The simulator must not flatter us. Every simulated fill applies:

- **Spread cost:** half the prevailing bid-ask, or a symbol-tier default when quotes are unavailable.
- **Slippage:** `max(0.05%, 0.1 × (orderQty / ADV) × dailyVolatility)` — superlinear in participation rate.
- **Latency:** fills priced at the tick ≥ 300 ms after the decision timestamp, never the decision-time price.
- **Partial fills:** an order exceeding 1% of the current bar's volume fills across bars.
- **Costs:** Indian brokerage + STT + exchange charges + GST + stamp duty, modelled explicitly. US: SEC + TAF fees. Crypto: taker fee.
- **No fill outside the bar's high/low.** Ever.

The same slippage/cost engine is applied on top of Alpaca and Binance testnet fills
in the Evaluator, so all three markets are measured on comparable terms.

### 9.5 Cost model (order-of-magnitude, to be validated in Phase 1)

Per full research cycle: shared packet ~15k tokens cached; 4 Haiku analysts ~8k
in / 2k out each; 1 Opus analyst; 4 debate turns Opus; 3 risk turns Opus; Auditor
Opus xhigh; Planner Opus; PM Opus. **Estimate ~$0.40–0.60 per cycle.**

At 50 symbols × 6 cycles/day ≈ 300 cycles/day ≈ **$120–180/day** — too much. So:

- **Two-stage triage.** A cheap Haiku pre-screen scores every symbol each interval; only the top N (default 8) or event-triggered symbols get a full cycle. Cuts spend ~90%.
- Prompt caching on the packet and on the stable system prompts.
- A hard monthly budget with auto-halt (NFR-5), visible on the dashboard.

### 9.6 Autonomy defaults

Every new market starts in `SHADOW`. Promotion to `CONFIRM` requires 2 weeks of
shadow decisions reviewed by the operator; promotion to `AUTO` requires 50 shadow
or confirm decisions and an Evaluator report. This is a policy, enforced in config,
not a suggestion.

---

## 10. Security & compliance

| Area | Requirement |
|---|---|
| Secrets | Env only; `.env` gitignored; CI secret scan; no key ever logged or emailed |
| Auth | Dashboard behind auth even on localhost; the kill switch must not be reachable unauthenticated |
| Paper-only | INV-1, enforced by allowlist + boot assertion + bundle grep test |
| India / SEBI | v1 places **no orders with any Indian broker**, so the algo framework does not apply. If a real adapter is ever added: static IP whitelisting, registered Strategy ID, exchange empanelment, broker due diligence, OAuth + 2FA, and pre-open session logout all become blocking prerequisites. Documented here so it is never forgotten. |
| Data licensing | Market-data terms differ per source; redistribution is prohibited by most. The dashboard is single-operator; do not expose raw vendor data publicly. |
| Disclaimer | Every email, every report, every dashboard page: educational/research, paper money, not financial advice. Inherited from both vendored toolkits. |
| Third-party licences | See `reference/MANIFEST.md`. AGPL code (OpenAlgo) is never linked. |

---

## 11. Acceptance criteria for v1

The system is done when all of these hold for **30 consecutive calendar days**:

1. Crypto, US, and India each run their full loop unattended through a complete session, with no manual intervention.
2. Every order in the database resolves to a complete lineage, and a randomly sampled order can be replayed from its `ContextPacket` hash.
3. Every trade action produced an email; p95 latency under 60 s; zero silent drops.
4. The Risk Officer's test suite passes, including property tests, and no order in the period breached a configured cap.
5. The kill switch was exercised in a drill and halted everything within one tick.
6. The dashboard shows live TradingView charts and our own fill overlays, updating over WebSocket.
7. The Evaluator produces a report with all § 5.8 metrics, all three benchmarks, and the confidence-tier attribution chart.
8. LLM spend stayed within budget and is attributed per agent, per cycle.
9. A written verdict exists: does the agent pipeline beat buy-and-hold after modelled costs, and is the sample large enough to say?

**Note on #9:** "no" is a valid, successful outcome. It is the honest result of a
well-built experiment, and it saves the money that a "yes" assumed without evidence.

---

## 12. Open questions for the operator

These change the work materially. Defaults are in effect unless you say otherwise.

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Starting paper capital per market? | US $100k (Alpaca default), Crypto $100k testnet, India ₹10,00,000 |
| Q2 | Risk budget: max % per position / max daily loss? | 5% per position, 20% per sector, 2% daily loss stop, 10 open positions |
| Q3 | Universe? | Crypto: top 10 by volume. US: S&P 100. India: Nifty 50 |
| Q4 | Holding horizon — swing (days–weeks) or intraday? | Swing. Intraday needs sub-minute infrastructure we are not building in v1 |
| Q5 | Monthly LLM budget ceiling? | $300/month with auto-halt |
| Q6 | Email destination + Resend vs SES? | Your work address; Resend |
| Q7 | Deploy target? | Local Docker Compose first; a small VPS once crypto runs 24/7 |

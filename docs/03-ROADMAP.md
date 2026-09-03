# 03 — Execution Roadmap

From an empty repo to a measured verdict. Companion to
[01-REQUIREMENTS.md](01-REQUIREMENTS.md) and [02-AGENT-ARCHITECTURE.md](02-AGENT-ARCHITECTURE.md).

---

## Sequencing principle

**Crypto first, India last.** Not the order the brief listed them, and here is why:

| | Crypto (Binance testnet) | US (Alpaca paper) | India (simulator) |
|---|---|---|---|
| Market hours | **24/7** | 6.5 h/day | 6.25 h/day |
| Paper venue | Real testnet, real matching | Real paper API | We must **build** it |
| Data | Free, real-time, WS | Free, real-time, WS (IEX) | Sourcing + licence work |
| Regulatory surface | None | None | SEBI framework (avoided by simulating) |
| Iteration speed | **Any hour of any day** | Weekday sessions only | Blocked on the simulator |

A 24/7 venue means you can debug the real-time loop at 11pm on a Sunday instead of
waiting for Monday's open. That alone is worth reordering for. India is last
because it is the only market where we must build the venue itself, and building
a fill simulator before we know the agent pipeline works is premature.

**The other principle: ship the measuring instrument before the thing being
measured.** The Evaluator and the decision-lineage store land in Phase 1, not
Phase 8. A pipeline that has been running for two months with no way to score it
has produced nothing.

---

## Phases

| # | Phase | Outcome | Est. |
|---|---|---|---|
| 0 | Foundation | Monorepo, DB, config, CI, paper-only invariant enforced and tested | 2–3 d |
| 1 | Broker spine | `BrokerAdapter` + Binance testnet + ledger + reconciliation + **real orders placed by hand** | 3–4 d |
| 2 | Risk + Router + Notifier | Deterministic gates, kill switch, email on every action | 3–4 d |
| 3 | Research tier | ContextPacket, triage, 5 analysts, structured outputs, caching | 4–6 d |
| 4 | Planning tier | Debates, Auditor, Execution Planner, PM — **first end-to-end auto trade (crypto, SHADOW)** | 5–7 d |
| 5 | Monitoring + Evaluator | Watch conditions, reflection loop, benchmarks, attribution | 4–5 d |
| 6 | Dashboard | TradingView widgets + Lightweight Charts overlays + live feed | 4–6 d |
| 7 | US market | Alpaca adapter, US calendar, SIP/IEX disclosure | 2–3 d |
| 8 | India market | Fill simulator, NSE/BSE data, Indian cost model | 5–7 d |
| 9 | Soak + verdict | 30-day unattended run, then the written answer | 30 d |

Estimates assume one engineer working with Claude Code. Phases 0–2 are the
foundation and are not optional; 3–4 are the actual product; 5–6 are what make it
usable and trustworthy; 7–8 are replication.

---

### Phase 0 — Foundation *(gate: the paper-only invariant is provably enforced)*

pnpm monorepo · Postgres + Drizzle · Redis · typed config with **fail-loud
coercion** (a misspelled boolean raises at boot rather than silently defaulting —
copied from `TradingAgents/default_config.py`) · structured logging · Vitest · CI.

**The one thing that must be true at the end of Phase 0:** INV-1 is enforced and
tested. `TRADING_MODE` accepts only `paper`; the `PAPER_ENDPOINTS` allowlist is
frozen; a test greps the built bundle for live broker hostnames and fails if any
appear. Everything else in this project is negotiable. That is not.

Detailed task-by-task plan: [`superpowers/plans/2026-09-03-phase-0-1-foundation-and-broker-spine.md`](superpowers/plans/2026-09-03-phase-0-1-foundation-and-broker-spine.md)

### Phase 1 — Broker spine *(gate: a hand-placed order round-trips and reconciles)*

`BrokerAdapter` interface + shared conformance suite · `BinanceTestnetAdapter`
(CCXT, `setSandboxMode(true)`) · Position Ledger with lot accounting · WS fill
stream · 60 s REST reconciliation with `RECONCILIATION_BREAK`.

**Gate:** submit an order from a script, watch the fill arrive over WebSocket, see
the ledger update, and see reconciliation agree with the venue. No agents yet.
Everything above this line is where money moves; prove it before adding
intelligence on top.

### Phase 2 — Risk, Router, Notifier *(gate: kill-switch drill passes)*

Risk Officer as pure functions with property-based tests · Order Router with
idempotency on `(decisionId, rungIndex)` · global HALT checked immediately before
every send · Notifier with the outbox pattern, Resend, retry, DLQ · React Email
templates for every event kind.

**Gate:** a drill. Engage the kill switch mid-flight; every open order cancels, no
new order is accepted, and an email lands. Then a rejection drill: propose an
order that breaches a cap and confirm it is rejected, persisted with a reason, and
emailed individually (never digested).

### Phase 3 — Research tier *(gate: cost per cycle within budget)*

ContextPacket builder with mandatory provenance · triage pre-screen · five
analysts in parallel with `output_config.format` · prompt caching on the packet ·
per-call cost/token/latency recording.

**Gate:** run 20 cycles on crypto. Verify `cache_read_input_tokens` is non-zero
(if it is zero, a silent cache invalidator is at work and the cost model is
wrong), and confirm measured cost per cycle is within the § 9.5 budget. Re-tune
triage top-N if not.

### Phase 4 — Planning tier *(gate: first end-to-end SHADOW decision)*

Bull/Bear debate with TradingAgents' termination rule · risk trio · **Auditor**
with the confidence floor · Execution Planner (ladder, bounds, thesis-break gate,
do-not-ladder list, suitability score) · Portfolio Manager with whole-book context.

**Gate:** a complete cycle produces a `Decision` with full lineage, an
`ExecutionPlan`, a PM verdict, and — in `SHADOW` mode — no order. Read ten of them
by hand. If the reasoning is not something you would act on, the prompts are
wrong, and no amount of downstream engineering fixes that.

Then flip crypto to `AUTO` and take the first automated paper trade.

### Phase 5 — Monitoring + Evaluator *(gate: the attribution chart exists)*

Watch conditions per FR-5.1 · re-trigger loop · Reflector with **alpha-aware**
outcome (raw return alone would score a +8% trade in a +12% market as a win) ·
Evaluator with all three benchmarks including the random-entry control.

**Gate:** the confidence-tier attribution chart renders with real data. Even with
n=20 and no significance, the plumbing must be real before the soak starts.

### Phase 6 — Dashboard *(gate: live, no polling)*

TradingView web-component widgets (Advanced Chart, Ticker Tape, Technical Analysis
gauge, Market Overview, heatmap) · **Lightweight Charts** for equity curve,
drawdown, fill markers, ladder rungs, stop/target lines — the widgets cannot
render our own fills, hence two chart systems · positions/orders/decision feed ·
agent-run inspector · WebSocket/SSE updates · permanent **PAPER TRADING** banner
and kill switch in the header.

### Phase 7 — US market *(gate: parity with crypto)*

`AlpacaPaperAdapter` against the shared conformance suite · US session calendar ·
PDT-style guard · **explicit IEX-vs-SIP disclosure** in the UI and an extra
slippage penalty in the Evaluator. Starts in `SHADOW` per § 9.6.

### Phase 8 — India market *(gate: the simulator does not flatter us)*

`IndiaSimAdapter`: NSE/BSE data ingestion · the § 9.4 fill model (spread, superlinear
slippage, ≥ 300 ms latency, partial fills across bars, never outside the bar's
high/low) · full Indian cost stack (brokerage, STT, exchange charges, GST, stamp
duty) · NSE holiday calendar · promoter-pledge signal in the Fundamental analyst.

**Gate:** replay a historical week through the simulator and confirm the modelled
fills are *worse* than naive close-price fills. A simulator that produces better
results than reality is not a simulator, it is a lie generator.

### Phase 9 — Soak and verdict

30 consecutive days, all three markets, unattended. Then the acceptance criteria
in § 11 of the requirements, and the written answer to: **does this beat
buy-and-hold after modelled costs, and is the sample large enough to say?**

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **LLM cost overrun** | High | High | Triage before full cycles; prompt caching; Haiku for volume; hard monthly cap with auto-halt; cost visible per agent on the dashboard |
| **Paper results don't survive real friction** | High | High | Explicit slippage/cost model on *all* venues (§ 9.4); random-entry control benchmark; treat any result under 100 closed trades as noise |
| **Agents produce plausible nonsense** | Medium | High | Auditor gate with confidence floor; structured outputs with `dataGap` rather than invention; mandatory provenance; read ten decisions by hand at the Phase 4 gate |
| **Reconciliation drift** | Medium | High | 60 s sweep; `RECONCILIATION_BREAK` halts new orders for that venue; ledger is source of truth but the venue is the arbiter |
| **A live-money path sneaks in** | Low | Catastrophic | INV-1: frozen endpoint allowlist, boot assertion, bundle-grep test in CI |
| **India data licensing** | Medium | Medium | Verify terms before use; single-operator, no redistribution; simulator needs only OHLCV |
| **SEBI framework misread** | Low | High | v1 places **zero** orders with any Indian broker, so the framework does not apply. Prerequisites are documented in requirements § 10 if that ever changes |
| **Alpaca IEX ≠ SIP** | Certain | Medium | Disclosed in UI; extra slippage penalty on US fills in the Evaluator |
| **AGPL contamination from OpenAlgo** | Low | High | Never linked. Arm's-length HTTP service only. Stated in `reference/MANIFEST.md` |
| **Overfitting the rubric to recent tape** | Medium | Medium | Rubric weights are versioned config recorded on every decision; retune only from walk-forward evidence, never from in-sample review |

---

## What "done" looks like, honestly

At the end of Phase 9 there is a dashboard, thirty days of decisions, and a
number. The number may say the agents added nothing after costs. That is a real
result, delivered cheaply, in paper money, with the machinery to prove it — and it
is worth more than a confident system with no way to check itself.

If the number says otherwise, then and only then does the conversation about real
capital, real brokers, and SEBI empanelment become worth having.

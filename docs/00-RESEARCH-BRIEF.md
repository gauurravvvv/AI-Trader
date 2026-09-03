# 00 — Research Brief

**Date:** 2026-09-03
**Purpose:** What we mined, from where, and exactly which pattern we are taking from each source. This is the evidence base for [01-REQUIREMENTS.md](01-REQUIREMENTS.md) and [02-AGENT-ARCHITECTURE.md](02-AGENT-ARCHITECTURE.md).

---

## A. Prompt toolkits (`reference/`)

### A1. `reference/ai-trading-claude/` — AI Trading Analyst (MIT, Zubair Trabzada)

16 markdown skills + 5 agent specs + one ReportLab PDF script. No runtime, no broker, no keys.

**What we take:**

| Pattern | Detail | Where it lands |
|---|---|---|
| **Weighted composite score** | `0.25·Technical + 0.25·Fundamental + 0.20·Sentiment + 0.15·Risk + 0.15·Thesis`, graded A+/A/B/C/D/F | `ConvictionScore` in the Portfolio Manager agent |
| **Inverted risk axis** | Risk sub-score is *higher = safer*, so it adds positively | Keeps the risk agent from being a veto-only actor; it can also argue *for* size |
| **Discovery-brief-first fan-out** | Orchestrator gathers shared context once, then launches 5 analysts in parallel on the same brief | `MarketContextPacket` — prevents 5 agents making 5 duplicate data calls |
| **Per-dimension 5×20 rubrics** | Each analyst scores 5 sub-dimensions 0–20 with explicit banding tables | Makes agent output auditable and diffable across runs |
| **Position-sizing formula** | `adjusted = base 5% × (risk_score / 70)`, capped 10%, floored 1% | Starting point for the sizing function (we replace with vol-targeting — see below) |
| **Structured JSON agent contracts** | Every agent spec ends with an exact JSON output shape | We enforce these with `output_config.format` (structured outputs), not prose parsing |

**What we deliberately do NOT take:** the toolkit fabricates nothing but also *verifies* nothing — no backtest, no ground truth, no P&L. Its scores have never been scored. We keep the rubric shape and add measurement.

### A2. `reference/InvestSkill/` — 26 analysis frameworks (MIT, yennanliu), v1.11.0

27 skill dirs, dual-published as `plugins/us-stock-analysis/skills/<n>/SKILL.md` (with frontmatter) and `prompts/<n>.md` (portable). Node ≥18, extensive CI. Far more rigorous than A1.

**What we take — the five load-bearing ideas:**

1. **The 5-phase research pipeline** (`full-report`), which independently converged on almost the same weights as A1:

   | Phase | Modules | Output | Weight |
   |---|---|---|---|
   | 1. Business & Competitive | stock-eval, competitor-analysis, fundamental-analysis | Business Quality 0–10 | 25% |
   | 2. Valuation | dcf-valuation, stock-valuation | Valuation 0–10 | 25% |
   | 3. Market Signals | insider-trading, institutional-ownership, earnings-call | Market Signal 0–10 | 20% |
   | 4. Technical Timing | technical-analysis, sector-analysis | Technical Setup 0–10 | 15% |
   | 5. Risk | short-interest, options-analysis, economics, 10-K risk | Risk Profile 0–10 (inverse) | 15% |

   Two independent MIT projects landing on 25/25/20/15/15 is weak evidence the weighting is sane. We adopt it as the **prior**, then let walk-forward evaluation retune it.

2. **Conflict-resolution rules** — explicit, and we hard-code them:
   - Fundamental overrides technical.
   - Consensus (4 of 5 phases) overrides an outlier; document the outlier, don't let it dominate.
   - Never suppress a conflicting signal.
   - Deeply contradictory → status `Conflicted — Monitor Only`, no trade.

3. **`result-validator`** — a meta-agent that scores *the analysis itself* 0–100 across Data Quality / Methodology / Signal Consistency / Risk Coverage / Reasoning Transparency (20 each), with tiers VERY HIGH → VERY LOW, and can *downgrade or reverse* the original signal. This is the single best idea in either repo. It becomes our **Auditor agent** and it is a mandatory gate before any order is emitted.

4. **`position-ladder`** — the only genuine execution-policy engine in either repo:
   - Share-count **floor** (never sell below) and **ceiling** (hard cap on adding). "At the ceiling, adding stops."
   - Rung spacing 1.0–1.5 × ATR(14); equal-dollar sizing preferred.
   - Trim/re-add cycle above/below blended average cost.
   - **Thesis-break gate** — hard stop conditions that end the ladder (thesis falsified vs delayed, governance red flags, leverage deterioration, estimates cut faster than price).
   - **Do-not-ladder list** — leveraged/inverse ETFs, binary-event names, anything where the bear case is solvency.
   - **Ladder Suitability Score 0–10** and a regime-fit check (ADX < 25 favorable, > 30 unfavorable).
   - Brutal honesty requirement: "lowering average cost is not the same as making money" — must report total return alongside average cost.

   This becomes our **Execution Planner** almost verbatim.

5. **`Thesis Invalidation` + `Re-run this analysis when` blocks** — every InvestSkill skill ends with what would reverse the signal and a checklist of re-trigger conditions (next earnings, ±15% price move, any fill, 60 days elapsed, material news). This is a **monitoring agent specification written as a prompt**. We turn it into real watch conditions in a database.

**Also taken:** the `Data & Sources` provenance header (`As of / Source / Retrieval / Confidence`) — every artifact must declare where its numbers came from and flag `model memory` as LOW confidence.

**Gap in both repos:** neither is US+India+Crypto, neither executes, neither measures. That is the whole delta of this project.

---

## B. Codebases (`reference/`) — the open-source landscape

| Project | License | What it proves | What we borrow |
|---|---|---|---|
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) (Tauric Research) — ~80k★ | Apache 2.0 | The firm-desk metaphor works as an agent topology. Built on LangGraph. | The **four-tier org chart**: Analyst Team (fundamentals / sentiment / news / technical) → Researcher Team (bull vs bear **structured debate**, `max_debate_rounds`) → Trader → Risk Management → Portfolio Manager with approve/reject authority. Also: `temperature: 0` for reproducibility, checkpointing for crash recovery. |
| [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) (virattt) — ~52k★ | MIT | Named investor personas make multi-agent debate *interpretable* — you can read why "Burry" disagreed with "Wood". Explicitly does **not** trade. | Optional **persona lens** layer over the bear/bull researchers (Graham margin-of-safety, Burry contrarian short, Taleb tail-risk). Also its split of discretionary (LLM persona) vs systematic (quant model) pods behind one interface. |
| [FinRL](https://github.com/AI4Finance-Foundation/FinRL) | MIT | RL strategies can go from notebook → live Alpaca execution reproducibly. | The **backtest → paper → (never) live** promotion gate as an explicit pipeline stage. |
| [AgenticTrading](https://github.com/Open-Finance-Lab/AgenticTrading) (Open-Finance-Lab) | open | Agent decisions should be *traceable experiments* — inspect reasoning and decision logs, benchmark against market baselines. | **Decision-log-as-first-class-artifact**: every order links to the full reasoning chain that produced it. Benchmark-vs-baseline is a product feature, not an afterthought. |
| [OpenAlgo](https://github.com/marketcalls/openalgo) (marketcalls) | **AGPL-3.0** | A unified API layer across 30+ Indian brokers already exists, self-hosted, with TradingView/Python/Node SDKs. | The **broker-adapter abstraction shape** for India. ⚠️ AGPL — we run it as a **separate self-hosted service over HTTP**, never as a linked library, so our code stays under our own license. |
| [CCXT](https://github.com/ccxt/ccxt) | MIT | One unified API + `setSandboxMode(true)` across 100+ crypto exchanges, with WebSocket `watch*` streams. | Our entire crypto adapter. |

---

## C. Venue / API research

### C1. US equities + crypto — Alpaca
- Paper trading is **free**, real-time, and open to **anyone globally** with just an email — no funding, no US residency.
- Paper endpoint `https://paper-api.alpaca.markets`; trading + market data + options APIs; REST **and** WebSocket.
- WebSocket `trade_updates` mirrors exactly what fires in the account — this is our fill event source.
- ⚠️ Free paper accounts get **IEX** data, not consolidated SIP. Single-exchange feed → prices can differ from the "real" NBBO. Must be disclosed in the UI and accounted for in slippage modelling.

### C2. Crypto — Binance Spot Testnet via CCXT
- `exchange.setSandboxMode(true)` immediately after construction, before any other call.
- Testnet supports Spot, Futures, Options. Free. WebSocket streaming via CCXT `watchTicker` / `watchOHLCV` / `watchOrders`.
- 24/7 market — the only venue with no session boundary, which makes it the best place to prove the real-time loop.

### C3. India — the hard one
- Broker APIs with WebSocket + REST: **Zerodha Kite Connect** (largest ecosystem, paid), **Angel One SmartAPI**, **Upstox**, **Dhan**, **Fyers**, **Alice Blue**, **Shoonya** (several free). Dhan and Fyers have native TradingView integration.
- **No mainstream Indian broker offers a true paper-trading sandbox on the order API.** Third-party simulators (Tradetron etc.) exist but are not API-first.
- **SEBI algo framework is fully in force from 2026-04-01** (deadline already passed as of today):
  - All automated orders must route through a SEBI-compliant broker API.
  - **Static IP whitelisting is mandatory** — dynamic IPs are rejected.
  - Each strategy needs a **unique Strategy ID** registered with the broker.
  - Algo providers must **empanel with the exchange** and pass broker due diligence; you cannot connect directly to an exchange.
  - Mandatory OAuth + 2FA; API sessions must auto-logout before the next pre-open.

  **Consequence for us:** even paper trading against a real Indian broker API is a compliance project, not a weekend integration. **Decision: India ships on our own deterministic simulator first**, fed by real market data, behind the same `BrokerAdapter` interface — so a Kite/Dhan adapter can be dropped in later without touching agent code. Documented in [01-REQUIREMENTS.md § 6.3](01-REQUIREMENTS.md).
- India market data (free/cheap tier): Yahoo-Finance-backed NSE/BSE REST wrappers, Twelve Data (free tier covers India), ICICI Breeze (free API access), or the broker's own feed once an adapter exists.

### C4. Charts — TradingView
- Two embed forms, same data: **web components** (`<tv-*>` custom tags) and classic **iframe + `<script>`**.
- Free widgets ship **with TradingView's own data** — Advanced Chart, Symbol Overview, Mini Chart, Ticker Tape, Market Overview, Screener, Technical Analysis gauge, Heatmaps, Economic Calendar, Top Stories.
- **Lightweight Charts™** (open source) and Charting Library / Advanced Charts require **you to supply the data**.
- **Design consequence:** widgets cannot render *our* fills, equity curve, or ladder rungs. So — TradingView widgets for the market view, **Lightweight Charts for our own overlays**. Two chart systems, deliberately.

### C5. Email
- **Resend** — first-class TS SDK, React Email templates, webhooks for delivery/bounce. Primary choice.
- Fallback: AWS SES (cheaper at volume, more setup) or plain SMTP via Nodemailer.

---

## D. Synthesis — the agent org chart we are building

Combining TradingAgents' desk metaphor, InvestSkill's validator + ladder, and AI-Trader's scoring:

```
                        ┌──────────────────┐
                        │  Scheduler /     │  cron + event triggers + watch conditions
                        │  Trigger Bus     │
                        └────────┬─────────┘
                                 │  MarketContextPacket (built once, shared)
      ┌──────────┬───────────┬───┴───────┬────────────┬──────────────┐
      ▼          ▼           ▼           ▼            ▼              ▼
 ┌─────────┐┌─────────┐┌──────────┐┌──────────┐┌───────────┐  RESEARCH TIER
 │Technical││Fundament││ Sentiment││   News   ││   Macro   │  (parallel, cheap model)
 │ Analyst ││ Analyst ││  Analyst ││  Analyst ││  Analyst  │
 └────┬────┘└────┬────┘└─────┬────┘└────┬─────┘└─────┬─────┘
      └──────────┴───────────┴──────────┴────────────┘
                                 │  AnalystReport[] (structured, scored 0–20 × 5)
                    ┌────────────┴────────────┐
                    ▼                         ▼                PLANNING TIER
              ┌───────────┐            ┌───────────┐           (debate, N rounds)
              │   Bull    │◄──debate──►│   Bear    │
              │Researcher │            │Researcher │
              └─────┬─────┘            └─────┬─────┘
                    └────────────┬────────────┘
                                 ▼
                        ┌─────────────────┐
                        │    Auditor      │  ← InvestSkill result-validator
                        │ (confidence     │     0–100, can veto or reverse
                        │  0–100 + veto)  │
                        └────────┬────────┘
                                 ▼
                        ┌─────────────────┐
                        │ Execution       │  ← InvestSkill position-ladder
                        │ Planner         │     rungs, floor/ceiling, stops
                        └────────┬────────┘
                                 ▼
                        ┌─────────────────┐
                        │  Risk Officer   │  DETERMINISTIC CODE, not an LLM
                        │  (hard gates)   │  caps, kill switch, PDT, exposure
                        └────────┬────────┘
                                 ▼
                        ┌─────────────────┐
                        │ Portfolio Mgr   │  final approve/reject/resize
                        │  (Opus 5)       │  cross-position, cross-market
                        └────────┬────────┘
                                 ▼
                        ┌─────────────────┐
                        │ Order Router →  │  EXECUTION TIER
                        │ BrokerAdapter   │  Alpaca | Binance TN | IN-Sim
                        └────────┬────────┘
                                 ▼
      ┌──────────────────────────┴──────────────────────────┐
      ▼                          ▼                          ▼
┌───────────┐            ┌──────────────┐          ┌────────────────┐
│  Monitor  │            │   Notifier   │          │  Evaluator     │  MONITORING TIER
│  (watch   │            │   (email     │          │  (P&L, bench-  │
│conditions)│            │  every trade)│          │  mark, attrib) │
└─────┬─────┘            └──────────────┘          └────────────────┘
      │ thesis-break / ±15% / earnings / fill → re-trigger
      └───────────────────► back to Scheduler
```

**Key architectural commitments that fall out of the research:**

1. **The Risk Officer is not an LLM.** Hard limits are deterministic code with unit tests. An LLM may *advise* on risk; it may never be the thing that decides whether a cap was breached.
2. **The Auditor gates every order.** No order is emitted below a configured confidence floor. Straight from `result-validator`.
3. **Structured outputs everywhere.** Every agent returns schema-validated JSON via `output_config.format`, never prose we regex.
4. **One shared context packet.** Built once per cycle, cached with `cache_control` — five analysts reading the same 30k-token packet should pay for it once.
5. **Every order carries its full decision lineage.** Order → PM decision → Auditor score → debate transcript → analyst reports → context packet → raw data snapshot. Immutable, replayable.

---

## E. The honest framing

The goal as stated is "maximise the profits." No system can promise that, and any design that assumes it will is the design that loses money. What this project can honestly deliver:

- A **measurable** decision pipeline — every trade traceable to a reasoning chain, benchmarked against buy-and-hold and against a random-entry control.
- **Paper money only**, enforced architecturally (see [01 § 3](01-REQUIREMENTS.md)) — there is no code path to a funded account.
- An **evaluation harness** that can tell us, after N months, whether the agents beat the benchmark after costs — and the discipline to say so if they don't.

We build the machine that answers "does this work?" before we build anything that assumes it does.

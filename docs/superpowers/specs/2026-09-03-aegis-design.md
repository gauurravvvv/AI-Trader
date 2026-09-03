# Aegis — Design Spec

**Date:** 2026-09-03
**Status:** Approved, ready for implementation planning
**Supersedes:** the runtime, cost, and agent-roster sections of [`docs/01-REQUIREMENTS.md`](../../01-REQUIREMENTS.md) and [`docs/02-AGENT-ARCHITECTURE.md`](../../02-AGENT-ARCHITECTURE.md)

---

## 1. What changed and why

The original Aegis design assumed an Anthropic API key and budgeted ~12 LLM calls per symbol per research cycle. Three findings killed that design.

### 1.1 `claude -p` is metered

Anthropic split billing on **2026-06-15**. Programmatic usage — explicitly *"Agent SDK, `claude -p`, Claude Code GitHub Actions, and third-party apps built on the Agent SDK"* — draws from a **separate monthly credit pool charged at standard API rates**: $20 (Pro), $100 (Max 5×), $200 (Max 20×). Non-rollover; when exhausted, programmatic access stops unless pay-as-you-go overage is enabled. Interactive terminal use is unaffected.

**Operator plan: Max 5× → $100/month ≈ $3.30/day.** Upgrade to Max 20× is contingent on this working.

Compliance is clear: [Anthropic's Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) permits an end user driving the unmodified `claude` binary with their own subscription. What is prohibited is routing *other users'* requests through subscription credentials. A single-operator local daemon is squarely permitted.

### 1.2 CLI latency is 3–10× the API

Measured on the target machine, trivial prompt, cold:

| Model | Latency | Note |
|---|---|---|
| `--model haiku` | **6.2 s** | returned ```` ```json ```` fences despite explicit instruction not to |
| `--model sonnet` | **17.8 s** | clean |

Process spawn plus session init, with no connection reuse. Twelve serialised calls per symbol would cost 75 s of pure overhead before any prompt processing.

The fenced output also confirms: **`output_config.format` structured outputs do not exist through the CLI.** A tolerant parser is required infrastructure, not a workaround.

### 1.3 The literature says generic LLM stock-picking does not work

- **[StockBench](https://arxiv.org/abs/2510.02209) (ICLR 2026):** across GPT-5, Claude-4, Qwen3, Kimi-K2 and GLM-4.5, *most models fail to beat buy-and-hold* (0.4% return, −15.2% drawdown over the test window). Agents underperform worst during downturns. Rankings invert between regimes, so no model is stably better.
- **[Agentic Trading survey](https://arxiv.org/abs/2605.19337):** 77 studies screened; 19 met the closed-loop-evaluation bar; of those, **2** reported time-consistent splits, **1** modelled transaction costs, **1** documented survivorship bias, and **0** were reproducible. Their conclusion: *architectural innovation is outpacing validation rigor.*
- A companion paper: **"The Alpha Illusion: Reported Alpha from LLM Trading Agents Should Not Be Treated as Deployment Evidence."**

Building a larger, cleverer version of "agents debate a stock and pick a direction" reproduces the architecture the evidence says loses.

### 1.4 What does have documented edge, and is LLM-native

**PEAD.txt** — text-based post-earnings-announcement drift ([JFQA](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/peadtxt-postearningsannouncement-drift-using-text/5EB217BB68B5FB054FE38541BAAC4679)). Drift predicted from earnings *text* is **larger than classic PEAD and remains material in recent years, when classic PEAD has decayed to roughly zero**. The `SUE.txt` measure works from call language alone. Drift is strongest in **low-liquidity, low-institutional-ownership** names.

This is the rare case where the model's real skill — reading long text consistently, at a scale no person can match — *is* the edge, rather than a price forecast in disguise.

Secondary: crypto information diffuses measurably more slowly than equities, and Fear-&-Greed contrarian signals still beat passive, though efficiency is rising and MEV tightens execution.

---

## 2. The thesis in one paragraph

Aegis is a single-operator, self-hosted, fully autonomous **paper-trading** daemon. It industrialises a small number of documented, text-driven market anomalies — starting with post-earnings drift in US equities — where the LLM's job is to **read filings fast and consistently**, never to forecast prices. Every other decision (screening, sizing, entry, stops, exits, reconciliation) is deterministic code. It runs from one command, streams a detailed live log to the terminal, and serves a web dashboard showing every agent, signal, position, decision chain and dollar of LLM spend.

---

## 3. Architecture: rules decide, Claude reads

The governing rule, and the reason the budget works:

> **Claude is spent on text that contains alpha. Everything with a right answer is code.**

Screening, indicator maths, position sizing, risk caps, stop placement, trailing, exits, order routing, reconciliation and benchmark maths are all deterministic — they have correct answers, and a `for` loop is more reliable than a language model at producing them.

### 3.1 Stack

**TypeScript monorepo, Node ≥20.** Rationale, in priority order:

1. The system is **I/O orchestration, not numerical computing** — HTTP fetches, websockets, subprocess spawning, SQLite writes, serving a UI. Node is strong at all five.
2. **The operator must be able to debug it while it holds positions.** A stack the operator cannot read is a larger risk than any library gap. (Operator is JS/TS-native.)
3. Typed contracts across three venue adapters is exactly where TS earns its keep.
4. Indicator maths is a solved dependency (`technicalindicators`), already proven in the TradeEase POC.

**Escape hatch:** statistical evaluation — walk-forward testing, deflated Sharpe, significance — is where Python genuinely wins. That is an *offline batch job*. If needed it becomes a standalone script invoked via subprocess. It never enters the live runtime. The daemon is not split across two languages.

**Storage:** SQLite (`better-sqlite3`). Single-operator, single-node, embedded — no Postgres, no Redis, no Docker required to run. Revisit only if concurrency demands it.

### 3.2 Data spine — free, essentially keyless

| Source | Provides | Cost / limit |
|---|---|---|
| **SEC EDGAR** | 8-K Ex-99.1 earnings releases, 10-K/10-Q, XBRL fundamentals, full-text search, nightly bulk | free, no key, 10 req/s, User-Agent required |
| **Alpaca Paper** | US quotes, bars, order execution, fill websocket | free, key from free signup |
| **Binance Spot Testnet** via CCXT | crypto data + execution, 24/7 | free, key from free signup |
| Finnhub free tier | earnings calendar; optional transcripts | free tier |
| RSS (Google News, ET, Moneycontrol) | headlines | free |

**The key insight:** the 8-K **Exhibit 99.1 is the earnings press release** — reported figures plus management's guidance language — and it appears on EDGAR within minutes of announcement, typically before any transcript exists. It is our primary text. Transcripts are optional enrichment, never a dependency.

Alpaca's free tier serves **IEX, not consolidated SIP**. This must be disclosed in the UI and carries an extra modelled slippage penalty.

---

## 4. The alpha engine — US post-earnings drift

The primary strategy, end to end. Two LLM calls per traded name, ≈ $0.15.

```
T−1   Earnings Calendar Agent     tomorrow's reporters ∩ universe          no LLM
T−0   EDGAR Poller                submissions feed every 20s for watched   no LLM
                                  CIKs; 8-K lands 3–30 min after the call

      Earnings Reader             reads Ex-99.1                    Sonnet 5  ~$0.09
        → { surpriseDirection, surpriseMagnitude, guidanceDelta,
            languageTone, hedgingDensity, oneLineWhy, confidence, dataGaps }

      Surprise Scorer             LLM read + XBRL actuals vs consensus     no LLM
                                  → SUE score

      Rules gate                  SUE ≥ threshold? liquidity? not held?    no LLM
                                  screen deliberately favours low
                                  institutional ownership — drift is
                                  strongest there

      Thesis Auditor              scores the reasoning 0–100, can  Sonnet 5  ~$0.06
                                  veto. Below floor → no order.

      Risk Officer → Router       sizing, caps, paper order                no LLM

T+1…T+60d
      Position Guardian           hold through the drift horizon,          no LLM
                                  trail the stop, time stop
```

**The bet, stated plainly:** classic PEAD has decayed toward zero; text-based PEAD has not. Reading the filing consistently within minutes across hundreds of names is something a person cannot do and this can. If that bet is wrong, the evaluation harness (§ 8) will say so.

### 4.1 Earnings Reader output contract

Strict JSON, parsed through the tolerant three-stage parser (§ 5.2). Every numeric field is either a real value or `null` with an entry in `dataGaps` — never invented.

```ts
interface EarningsRead {
  cik: string; ticker: string; accessionNo: string; filedAt: string;
  surpriseDirection: 'BEAT' | 'MISS' | 'INLINE' | 'UNCLEAR';
  surpriseMagnitude: number | null;   // 0–1, model's own confidence-weighted magnitude
  guidanceDelta: 'RAISED' | 'MAINTAINED' | 'LOWERED' | 'WITHDRAWN' | 'NONE';
  languageTone: number;               // −1 … +1
  hedgingDensity: number;             // 0–1; rising hedging is a documented negative
  keyQuotes: { quote: string; why: string }[];   // max 3, verbatim from the filing
  oneLineWhy: string;
  confidence: number;                 // 0–100
  dataGaps: { field: string; reason: string }[];
}
```

`keyQuotes` must be verbatim substrings of the source document; the scorer verifies this and discards any quote that is not, treating fabrication as a hard signal-quality failure.

### 4.2 The SUE score and its gate

The Surprise Scorer fuses the model's textual read with hard XBRL numbers into a single standardised score:

```
SUE = 0.5 · z(actualEPS − consensusEPS)          // classic numeric surprise, from XBRL
    + 0.3 · signedMagnitude(EarningsRead)         // surpriseDirection × surpriseMagnitude
    + 0.2 · guidanceScore(EarningsRead)           // RAISED +1, MAINTAINED 0, LOWERED −1, WITHDRAWN −1.5
```

`languageTone` and `hedgingDensity` are recorded but **not** in the v1 score — they are candidate features for retuning once the evaluator has enough closed trades to test them, and adding untested terms up front is how a score becomes unfalsifiable.

**Entry gate:** `SUE ≥ 1.5` (long) or `SUE ≤ −1.5` (skip — no shorting in v1), **and** average daily dollar volume above the liquidity floor, **and** the name is not already held, **and** the Auditor clears its confidence floor.

The 1.5 threshold and the three weights are **versioned config recorded on every decision**, not constants. They are a starting prior, retuned only from walk-forward evidence — never from reviewing the trades we already took.

---

## 5. Agent runtime

### 5.1 Model invocation

`claude --print --model <model> -p <prompt>` spawned via `child_process.spawn`, with `CLAUDECODE` and `CLAUDE_CODE` deleted from the child environment (otherwise Claude Code detects a nested session). Ported from the TradeEase POC, where it is proven.

Concurrency is capped globally (default 3 simultaneous `claude` processes) because each is a full Node process; unbounded fan-out will thrash the machine and the rate limiter.

### 5.2 Parsing

No structured outputs exist through the CLI, and Haiku demonstrably ignores "no markdown" instructions. Required, in order:

1. direct `JSON.parse`
2. strip ``` fences, retry
3. locate first `{`/`[`, parse from there

Then field-name normalisation (`entry_price ?? entryPrice`), schema validation with Zod, and one retry with the validation error appended. On second failure the signal is dropped with a `dataGap`, never guessed.

### 5.3 Agent bus

A SQLite `agent_signals` table as a durable producer/consumer bus — `consumed`, `consumed_by`, `consumed_at`. Ported from TradeEase. Chosen over in-process events because it survives a crash, is inspectable from the UI, and gives every message an audit trail.

### 5.4 Agent roster

| Agent | Trigger | Model | Purpose |
|---|---|---|---|
| Market Data | 5 s–1 m | — | quotes, bars, indicators |
| Earnings Calendar | daily 16:30 ET | — | tomorrow's reporters ∩ universe |
| EDGAR Poller | 20 s in earnings windows | — | watch submissions for 8-K |
| Screener | 15 m | — | rule-based universe ranking |
| **Earnings Reader** | 8-K signal | Sonnet 5 | the alpha engine |
| Surprise Scorer | earnings-read signal | — | fuses LLM read with XBRL actuals into the SUE score; verifies `keyQuotes` are verbatim |
| **News Triage** | 5 m batch | Haiku 4.5 | headline → material/direction |
| **Filing Reader** | held-position 10-Q | Sonnet 5 | risk-factor deltas |
| **Thesis Auditor** | pre-order | Sonnet 5 | scores reasoning 0–100, can veto |
| Risk Officer | pre-order, sync | — | hard caps, deterministic |
| Execution | approved order | — | route to venue adapter |
| Reconciler | 60 s | — | ledger vs venue |
| Position Guardian | 1 m | — | stops, targets, trailing, time stop |
| **Reflector** | position close | Haiku 4.5 | alpha-aware lesson → memory |
| Orchestrator | always | — | lifecycle, staggered starts |
| Budget Governor | always | — | spend tiers, graceful degradation |

Sixteen agents; five use a model, and all five are event-triggered rather than polling.

Ported from TradeEase: `BaseAgent` interval ticker with a `shouldRun()` gate, staggered starts, and **sleep/suspend gap detection** — a laptop lid closing mid-session is a real failure mode that only shows up in practice.

---

## 6. Budget Governor

Under a hard monthly cap, exhausting credit mid-position is a genuine failure mode. Spend is tiered and **degrades rather than dies**:

| Monthly spend | Mode | Behaviour |
|---|---|---|
| 0–70% | Normal | all agents active |
| 70–85% | Conserve | Haiku for triage; Auditor bar raised |
| 85–95% | Essential | earnings reads for *held* positions only; no new entries |
| > 95% | Rules-only | deterministic exits, stops and reconciliation remain fully functional |

**Rules-only mode is fully autonomous and safe.** The system must never become unable to protect an open position because it ran out of credit. Every LLM call records model, tokens, cost, latency and agent; spend is projected against days remaining in the cycle and surfaced in both UIs.

---

## 7. Interfaces

### 7.1 Terminal — the primary surface

A live-trailing structured log, colour-coded per agent. Every model call shows model, tokens in/out, cost, latency; every cycle footer shows running spend.

```
14:32:07  edgar-poller    ▸ 8-K detected  NVDA  acc 0001045810-26-000123
14:32:09  earnings-reader ◆ sonnet-5  in 18,412  out 1,203  $0.086  11.4s
14:32:09  earnings-reader ▸ NVDA  surprise +BEAT  mag 0.71  guidance RAISED  conf 82
14:32:10  surprise-scorer ▸ NVDA  SUE 2.14  → passes gate (≥1.5)
14:32:11  thesis-auditor  ◆ sonnet-5  in 9,880  out 902  $0.043  6.8s
14:32:11  thesis-auditor  ▸ NVDA  confidence 78/100 HIGH — no red flags
14:32:12  risk-officer    ✓ NVDA  $4,820  4.8% equity  within all caps
14:32:12  execution       ▸ NVDA  BUY 26 @ mkt → alpaca-paper  ord a3f9…
14:32:14  execution       ✓ FILLED 26 @ $185.42
14:32:14  notifier        ✉ trade email queued
          ── budget: $19.40 / $100 this cycle (19%) · 11 days elapsed
```

Flags: `--verbose` (full prompts and raw responses), `--agent <name>` (filter), `--quiet` (decisions and fills only).

### 7.2 Web dashboard — `localhost:3777`

Same event stream over WebSocket. Panels: agent health grid; live signal bus; positions with P&L; decision feed with expandable reasoning chains; **TradingView widgets** for market view; **Lightweight Charts** for our own fills, ladder levels and equity curve (widgets cannot render our data — two chart systems, deliberately); budget gauge with projected burn; permanent **PAPER TRADING** banner and kill switch.

### 7.3 Email

Ported `nodemailer` path. Every trade action, plus risk breaches, reconciliation breaks and budget-tier transitions. Outbox pattern — the notification row is written in the same transaction as the state change it describes.

---

## 8. Evaluation — the actual deliverable

Given § 1.3, the system must be able to prove or disprove itself.

- Benchmarks: buy-and-hold of the same universe, SPY, and a **random-entry control** with matched trade count and holding period.
- Full cost modelling on every venue — spread, superlinear slippage, commission, and the IEX-vs-SIP penalty on US fills.
- **Return bucketed by Auditor confidence tier.** If high-confidence decisions do not outperform low-confidence ones, the Auditor is decorative and the pipeline is theatre. This is the single most important chart.
- No edge is claimed below 100 closed trades.

"It does not beat buy-and-hold" is a valid and successful outcome, delivered cheaply in paper money.

---

## 9. Invariants (carried forward, unchanged)

1. **Paper money only.** No code path to a funded account: `TRADING_MODE` accepts only `paper`; venue base URLs come from a frozen allowlist; a test fails the build if a live broker hostname appears in source.
2. **No order without a full decision lineage.**
3. **No order below the Auditor's confidence floor.**
4. **Risk limits are deterministic code, never a model.**
5. **Every number carries provenance**; `model_memory` is rejected as an input to any order-producing agent.
6. **Kill switch honoured within one tick.**
7. **Every trade action emails the operator.**
8. **No fabricated numbers** — `null` plus a `dataGap`, never a guess. Extended here: `keyQuotes` must verify as verbatim substrings of the source filing.

---

## 10. Rollout

Operator priority: **US → Crypto → India.**

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Monorepo, config, SQLite schema, paper-only invariant | live-hostname test fails the build |
| 1 | `claude -p` runtime, tolerant parser, budget ledger | 20 calls logged with accurate cost |
| 2 | Signal bus, BaseAgent, orchestrator, terminal logger | agents start staggered, survive a sleep/wake |
| 3 | Alpaca adapter, ledger, reconciler, risk officer, router | hand-placed order round-trips and reconciles |
| 4 | **EDGAR poller + Earnings Reader + Surprise Scorer** | a real 8-K parsed end to end into a scored signal |
| 5 | Thesis Auditor, first autonomous paper trade (US) | ten decisions read by hand and judged sound |
| 6 | Web dashboard, TradingView, email | live over WebSocket, no polling |
| 7 | Position Guardian, Reflector, Evaluator | confidence-tier attribution chart renders |
| 8 | Crypto (Binance testnet) | same conformance suite passes |
| 9 | India | simulator produces *worse* fills than naive replay |
| 10 | Soak — one full earnings season | written verdict |

Crypto is switched on early alongside US — not as a focus, but because a 24/7 market is the only way to smoke-test a daemon without waiting for Monday.

---

## 11. Attribution

Ported from the operator's own TradeEase POC: the `claude -p` wrapper including the env-var deletion, the three-stage `extractJson` and field normalisation, the `agent_signals` bus schema, `BaseAgent` and its `shouldRun()` gate, sleep/suspend gap detection, ATR and trailing-stop maths, and the emailer.

Patterns adapted from vendored references (see [`reference/MANIFEST.md`](../../../reference/MANIFEST.md)): debate-termination control flow and the alpha-aware reflection loop from TradingAgents (Apache-2.0); the validator-as-gate and position-ladder framing from InvestSkill (MIT); the weighted-composite and 5×20 rubric shape from ai-trading-claude (MIT).

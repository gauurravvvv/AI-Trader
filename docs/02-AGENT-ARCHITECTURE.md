# 02 — Agent Architecture

**How every agent works: research → planning → execution → monitoring.**
Companion to [01-REQUIREMENTS.md](01-REQUIREMENTS.md). Evidence in [00-RESEARCH-BRIEF.md](00-RESEARCH-BRIEF.md).

---

## 0. The shape of the system

Four tiers. The important structural claim: **the tiers get less intelligent and
more deterministic as you approach the money.** Research is fully LLM. Planning is
LLM with structured output. Execution has an LLM proposing and *deterministic code
disposing*. Monitoring is mostly code with an LLM for reflection.

```
TIER 1  RESEARCH     5 analysts, parallel, rubric-bounded        LLM, cheap
TIER 2  PLANNING     debate → audit → plan → PM                  LLM, expensive
TIER 3  EXECUTION    risk gate → router → adapter                CODE (gate) + code
TIER 4  MONITORING   watch conditions → re-trigger → reflect     code + cheap LLM
```

The reason for that gradient: an LLM that hallucinates a support level costs you a
mediocre entry. An LLM that hallucinates a position limit costs you the account.
So limits are code.

### 0.1 The full cycle

```
 TRIGGER ──► [Triage]  cheap pre-screen: which symbols deserve a full cycle?
    │                                            │ top-N + event-forced
    ▼                                            ▼
 [ContextPacket Builder]  ── one packet, cached, shared by all five analysts
    │
    ├──► Technical Analyst    ─┐
    ├──► Fundamental Analyst   │  parallel, same packet, prompt-cached
    ├──► Sentiment Analyst     ├──► AnalystReport[5]
    ├──► News/Catalyst Analyst │      each: 5 sub-scores 0–20 → dimension 0–100
    └──► Macro/Regime Analyst ─┘
                                        │
                                        ▼
                         [Bull Researcher] ⇄ [Bear Researcher]     N rounds
                                        │
                                        ▼
                         [Aggressive] → [Conservative] → [Neutral]  risk trio, M rounds
                                        │
                                        ▼
                              [AUDITOR]  0–100 confidence  ── below floor? STOP. no order.
                                        │
                                        ▼
                         [Execution Planner]  rungs, floor/ceiling, stops, thesis-break
                                        │
                                        ▼
                         [Portfolio Manager]  approve / resize / reject  (sees whole book)
                                        │
                    ════════════════════╪════════════════════  LLM boundary
                                        ▼
                         [RISK OFFICER]  deterministic gates    ── breach? REJECT. logged.
                                        │
                                        ▼
                         [Order Router] → BrokerAdapter → venue
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
              [Ledger]            [Notifier]           [Monitor]
              fills, lots         email every          watch conditions
              avg cost            action                     │
                    │                                        │ fired
                    └──────────► [Evaluator]                 └──► back to TRIGGER
                                 P&L, benchmarks,
                                 attribution              [Reflector] on close
                                                          alpha-aware lesson
                                                                 │
                                                                 └──► memory, read by
                                                                      future analysts
```

### 0.2 Contracts, not conversations

Every agent boundary is a **schema-validated JSON contract** produced with
`output_config.format` — never prose we parse. Rationale: TradingAgents structures
only its three decision agents and leaves analysts as prose; that makes analyst
output un-diffable across runs and un-scoreable. We structure everything, and keep
a free-text `narrative` field on each schema so the human-readable reasoning
survives.

Every agent call records: `modelId`, `promptVersion`, `rubricVersion`,
`packetHash`, `tokensIn/Out`, `costUsd`, `latencyMs`. That is what makes the
Evaluator's attribution chart (FR-8.3) possible.

---

## TIER 1 — RESEARCH

### 1.0 Triage (pre-agent, cost control)

Not really an agent — a single cheap call that stops us spending $0.50 on a symbol
that hasn't moved.

| | |
|---|---|
| **Model** | `claude-haiku-4-5` |
| **Input** | Compact table of the whole universe: last, %chg, volume vs ADV, RSI, distance from 20/50/200 MA, days to earnings, any news flag |
| **Output** | `{ symbol, triageScore: 0-100, reason: string }[]` |
| **Effect** | Top N (default 8) plus every event-forced symbol proceed to a full cycle |
| **Why** | § 9.5 of the requirements — this is the difference between $150/day and $15/day |

### 1.1 ContextPacket Builder (code, not an agent)

Deterministic. Fetches everything once so five analysts don't make five duplicate
API calls — the single most valuable idea taken from `ai-trading-claude`'s
"Discovery Brief" phase.

**Produces:**

```ts
interface ContextPacket {
  packetId: string;
  contentHash: string;          // makes the cycle replayable
  symbol: string; market: MarketId; asOf: string;
  quote:      { last, bid, ask, dayChangePct, volume, adv20 };
  ohlcv:      { '1m'|'5m'|'1h'|'1d': Bar[] };
  indicators: { ma20, ma50, ma200, rsi14, macd, atr14, adx14, bbUpper, bbLower, obv };
  levels:     { support: Level[]; resistance: Level[]; week52High; week52Low };
  fundamentals?: {...} | null;  // null + dataGap for crypto
  onchain?:      {...} | null;  // crypto only
  news:       NewsItem[];       // each with {source, publishedAt, url}
  calendar:   { nextEarnings?, exDividend?, knownEvents[] };
  regime:     { indexTrend, vix|equivalent, sectorRelStrength, adxRegime };
  memory:     Reflection[];     // past lessons for THIS symbol — the learning loop
  sources:    Provenance[];     // INV-5: every number traceable
}
```

**Provenance is mandatory (INV-5).** Each entry is
`{field, source, retrievedAt, confidence: 'live'|'delayed'|'cached'|'model_memory'}`.
Anything marked `model_memory` is rejected as input to an order-producing agent.
Adopted from InvestSkill's `Data & Sources` header.

**Caching:** the packet is serialized once and sent as a cached prefix
(`cache_control: {type:'ephemeral'}`) so the five analysts pay full price for it
once, then ~10% thereafter.

---

### 1.2 The five analysts

All five run **in parallel, in one message**, against the same packet. All five
share one contract:

```ts
interface AnalystReport {
  dimension: 'technical'|'fundamental'|'sentiment'|'news'|'macro';
  score: number;                 // 0-100, = sum of subScores
  subScores: { name: string; score: number; max: 20; assessment: string }[];  // exactly 5
  signal: 'STRONG_BULL'|'BULL'|'NEUTRAL'|'BEAR'|'STRONG_BEAR';
  keyFindings: string[];         // 3-5, each must cite a number from the packet
  risks: string[];
  dataGaps: { field: string; reason: string }[];   // INV-8
  narrative: string;             // human-readable, <= 250 words
  rubricVersion: string;
}
```

The 5 × 20 rubric shape is taken directly from `ai-trading-claude`'s agent specs —
it is the thing that makes two runs on different days comparable.

#### 1.2.1 Technical Analyst — 25% weight

`claude-haiku-4-5`. Tools: none (everything is in the packet).

| Sub-dimension | 0–20 banding (abridged) |
|---|---|
| Trend | 17–20 price > MA50 > MA200, all rising · 9–12 between MAs · 0–4 death cross, lower lows |
| Momentum | 17–20 RSI 55–70 rising + MACD above signal · 0–4 RSI < 30 or > 80 with reversal |
| Volume | 17–20 up days on above-avg volume, OBV rising · 0–4 climactic distribution |
| Pattern | 17–20 confirmed bullish pattern · 9–12 no pattern · 0–4 confirmed breakdown |
| Relative strength | 17–20 top decile vs benchmark · 0–4 bottom decile |

Must also emit `keyLevels` (≥ 2 support, ≥ 2 resistance) — the Execution Planner
uses these as candidate ladder rungs.

#### 1.2.2 Fundamental Analyst — 25% weight

`claude-opus-5`, `effort: medium`. Tools: `fetch_filing`, `fetch_financials`.
**Replaced by the On-chain analyst for crypto.**

Sub-dimensions: Valuation · Growth · Profitability · Financial Health · Moat.
Bandings adopted from `reference/ai-trading-claude/agents/trade-fundamental.md` cross-checked
against InvestSkill's `stock-eval` (Piotroski F-Score, ROIC vs WACC, DuPont).

**Market-specific:** Indian symbols use INR-native metrics and Indian disclosure
(annual report, quarterly results, shareholding pattern, promoter pledge — that
last one has no US analogue and is a genuine red flag signal).

#### 1.2.3 On-chain / Tokenomics Analyst — crypto only, 25%

`claude-opus-5`, `effort: medium`. Sub-dimensions: Supply schedule & emissions ·
Holder concentration · Exchange net flows · Network activity · Funding rate &
open interest. Exists because "P/E" is meaningless for BTC and pretending
otherwise would silently poison the composite.

#### 1.2.4 Sentiment Analyst — 20%

`claude-haiku-4-5`. Sub-dimensions: News tone · Social buzz · Analyst consensus ·
Institutional flow · Insider/short signals.

**Contrarian flags are mandatory** — extreme euphoria is a top signal, extreme
fear a bottom signal. The agent must emit `contrarianFlags[]` when unanimity is
detected. This is lifted from `reference/ai-trading-claude/agents/trade-sentiment.md`, which
handles it better than any other source we read.

#### 1.2.5 News / Catalyst Analyst — folded into the 20% sentiment weight

`claude-haiku-4-5`. Forward-looking, not backward: builds a 90-day catalyst
calendar (earnings, product launches, regulatory decisions, index rebalances,
token unlocks, lockup expiries) with an expected-impact direction and magnitude
per event. Modelled on InvestSkill's `catalyst-calendar`. Its output feeds the
Execution Planner's **time stop** and the Monitor's watch conditions.

#### 1.2.6 Macro / Regime Analyst — 15% (part of the risk axis)

`claude-haiku-4-5`. Runs **once per market per interval**, not per symbol — regime
is a market property. Cached and injected into every packet for that market.

Sub-dimensions: Cycle phase · Rate environment · Sector rotation · Volatility
regime · Cross-asset stress. Output includes `adxRegime` (trending vs
range-bound), which the Execution Planner needs for its ladder suitability check.

---

## TIER 2 — PLANNING

### 2.1 Bull vs Bear debate

Two agents, `claude-opus-5`, `effort: high`, alternating. Both see all five
analyst reports and the opponent's previous turn. **Control flow copied from
`TradingAgents/graph/conditional_logic.py`:**

```
alternate Bull → Bear → Bull → Bear …
terminate when  debateState.count >= 2 * maxDebateRounds   (default 2 → 4 turns)
next speaker    = opposite of whoever spoke last
```

Each turn returns:

```ts
interface DebateTurn {
  side: 'bull'|'bear'; round: number;
  claims: { claim: string; evidence: string; sourceRef: string; strength: 'strong'|'moderate'|'weak' }[];
  rebuttals: { targetClaim: string; rebuttal: string }[];   // empty on round 1
  concessions: string[];        // what the other side got right — forces honesty
  priceTarget?: number; probability?: number;
}
```

**`concessions` is not decorative.** A debater that concedes nothing across four
turns is pattern-matching, not reasoning; the Auditor penalises zero-concession
debates under Reasoning Transparency.

**Optional persona lens** (from `ai-hedge-fund`): the bear can be instantiated as
Burry (accounting-forensic), Taleb (tail-risk), or Graham (margin-of-safety); the
bull as Wood (disruption), Lynch (growth-at-reasonable-price), or Fisher (quality).
Off by default — enable per universe. It makes disagreement *legible*, which is
its real value.

### 2.2 Risk trio debate

Three agents, `claude-opus-5`, `effort: medium`, rotating
**Aggressive → Conservative → Neutral**, terminating at
`count >= 3 * maxRiskRounds` (default 1 → 3 turns). Also from TradingAgents.

They argue **size, not direction** — the direction question was settled upstream.
Aggressive argues for a larger position given the asymmetry; Conservative argues
for a smaller one given the tail; Neutral adjudicates and proposes a number.

Output: `{ recommendedSizePct, stopDistanceAtr, maxAdverseExcursionTolerated, dissent[] }`.

### 2.3 The Auditor — the gate

`claude-opus-5`, `effort: xhigh`. The highest-effort, lowest-frequency agent, and
the single most important one. Taken almost verbatim from InvestSkill's
`result-validator`.

It reads the entire chain — packet, five reports, both debates — and scores **the
analysis, not the stock**:

| Dimension | 0–20 | What it checks |
|---|---|---|
| Data Quality | 20 | Sources cited? Recency (< 30d = 5, 30–90d = 3, > 90d = 1)? Completeness? Internal contradictions? |
| Methodology | 20 | Right valuation method for the sector/stage? Assumptions explicit and in range? Cross-validated by ≥ 2 methods? |
| Signal Consistency | 20 | Technical ↔ fundamental aligned (7)? Sentiment aligned (7)? Macro supports the thesis (6)? |
| Risk Coverage | 20 | ≥ 3 specific downside risks? Bear case *quantified*, not just listed? Catalysts both ways? |
| Reasoning Transparency | 20 | Conclusion follows from evidence? Contrarian view genuinely considered? Limitations acknowledged? |

Tiers: 85+ VERY HIGH · 70–84 HIGH · 55–69 MEDIUM · 40–54 LOW · < 40 VERY LOW.

**Authority — this is what makes it a gate rather than a comment:**

- Below `AUDIT_FLOOR` (default 70) → **cycle terminates, no order** (INV-3).
- It may **downgrade** the signal (BUY → HOLD) or **reverse** it.
- It emits `redFlags[]` and `warnings[]`; any red flag forces `CONFLICTED_MONITOR_ONLY`.
- It applies the coded conflict rules: fundamental over technical; 4-of-5 consensus over an outlier; never suppress a conflict.

The Auditor is deliberately given no information about the portfolio, P&L, or how
many trades we have made today. It judges the argument in isolation. Giving it
context about our P&L would give it a reason to be lenient.

### 2.4 Execution Planner

`claude-opus-5`, `effort: high`. This is InvestSkill's `position-ladder`,
implemented. It answers "I want this — now what is the plan?"

**Phase 1 — bounds first, before any rung.** Ceiling = the *most restrictive* of
concentration cap (≤ 10% large-cap, ≤ 5% high-beta/single-product), capital cap
(total cash if every rung fills — the most common failure is discovering the full
ladder costs more than you have), and loss-tolerance cap (ceiling shares × (bottom
rung − bear-case price): survivable?). Floor = 50–70% of ceiling, the core you
would still want if the name did nothing for two years.

> **The cap rule, stated verbatim in every plan:** *At the ceiling, adding stops.
> Further weakness is not a reason to add beyond the cap — it is a reason to
> re-run the thesis gate. Raising the ceiling mid-drawdown is the single most
> common way this plan fails.*

**Phase 2 — the ladder.** Rungs spaced 1.0–1.5 × ATR-14 (tighter than 0.5 × ATR
and they all fill on one day's noise; wider than 2 × ATR and they never fill), or
placed on the Technical Analyst's support levels when those are clean — the
highest-quality placement. **Equal-dollar sizing** by default, which mechanically
buys more shares lower.

Required arithmetic, always shown: blended average cost at full fill · total
capital at full fill · drawdown to full fill · unrealised loss at full fill ·
dry powder remaining.

**The underfill problem** — a ladder on a name in a durable uptrend never fills and
the analysis is wasted. Two mitigations, chosen *in advance*, never in the moment:
a starter tranche (30–40% at market now) or a time-based backstop (re-anchor or
accept a smaller position after the time budget).

**Phase 3 — trim/re-add.** Above blended average cost, sell highest-cost lots
first, never below the floor. Below the new average, re-add toward the ceiling.
A completed cycle in a range-bound tape ends at *the same share count at a lower
average cost* — that, and only that, is where the edge comes from.

**Phase 4 — the thesis-break gate.** Hard stop, do not add, consider exiting:
thesis **falsified** rather than merely delayed · governance/accounting red flags ·
leverage deterioration or dilutive emergency financing · the decline is
fundamental not technical (estimates cut as fast as price falls, so it is *not*
getting cheaper) · concentration cap already breached.

**Do-not-ladder list — the planner refuses and says why:** leveraged/inverse ETFs
(path-dependent decay), binary-event names (no mean to revert to), anything where
the bear case is **solvency** rather than valuation.

**Ladder Suitability Score 0–10** = thesis integrity (0–3) + regime fit (0–2) +
volatility adequacy (0–2) + position headroom (0–2) + account/tax fit (0–1).
Below 4.0 the planner returns a single sized entry instead of a ladder; below
3.0 it returns no plan.

**Mandatory honesty clause in every plan** (InvestSkill's, and it is right):
*lowering average cost is not the same as making money.* Total return and realised
P&L are reported alongside average cost, with a buy-and-hold comparison.

### 2.5 Portfolio Manager — final authority

`claude-opus-5`, `effort: xhigh`. **The only agent that sees the whole book.**

Inputs: the Decision so far, the ExecutionPlan, plus current positions across all
three markets, cash, gross/net exposure, sector and factor concentration,
correlation of the candidate to existing holdings, today's realised P&L, and how
many decisions have already fired today.

Output:

```ts
interface PMDecision {
  action: 'APPROVE'|'RESIZE'|'REJECT'|'DEFER';
  approvedQty: number; approvedRungs: Rung[];
  convictionScore: number;    // 0-100, the weighted composite
  grade: 'A+'|'A'|'B'|'C'|'D'|'F';
  rationale: string;                    // <= 200 words, goes in the email
  crossPositionNotes: string[];         // "already 22% tech; this adds 4%"
  rejectReason?: PMRejectReason;
}
```

**The composite** — the 25/25/20/15/15 prior that `ai-trading-claude` and
InvestSkill independently converged on:

```
conviction = 0.25·technical + 0.25·fundamental + 0.20·sentiment
           + 0.15·riskProfile + 0.15·thesisConviction
```

`riskProfile` is **inverted — higher means safer** — so it contributes positively.
Grades: 85+ A+ Strong Buy · 70 A Buy · 55 B Hold · 40 C Neutral · 25 D Caution ·
< 25 F Avoid.

**The weights are a prior, not a truth.** They are config, recorded on every
decision, and the Evaluator's attribution (FR-8.3) is what will eventually retune
them from walk-forward evidence.

---

## TIER 3 — EXECUTION

### 3.1 Risk Officer — deterministic, no LLM (INV-4)

Pure functions. Property-based tests. Zero I/O beyond the ledger read. Runs in
under 50 ms. **This is the only component that can say no and mean it.**

| Gate | Default | Reject code |
|---|---|---|
| Per-position notional cap | 5% of equity | `POSITION_CAP` |
| Per-sector cap | 20% | `SECTOR_CAP` |
| Per-market cap | 50% | `MARKET_CAP` |
| Gross exposure cap | 100% (no leverage) | `GROSS_EXPOSURE` |
| Daily realised-loss stop | −2% of equity → halt new entries | `DAILY_LOSS_STOP` |
| Max open positions | 10 | `MAX_POSITIONS` |
| Min liquidity | order ≤ 1% of ADV20 | `LIQUIDITY` |
| Min notional / lot / tick | per venue constraints | `VENUE_CONSTRAINT` |
| Duplicate-order guard | no same symbol+side within 60 s | `DUPLICATE` |
| Symbol blocklist | operator-managed | `BLOCKLIST` |
| Global HALT | INV-6 | `HALTED` |
| Session check | market open, or venue is 24/7 | `MARKET_CLOSED` |

Every evaluation — pass or fail — is persisted as a `RiskEvaluation` row. A
rejection emails immediately (never digested) because a rejection means an agent
proposed something the limits forbade, and that is information about the agents.

### 3.2 Order Router

Takes an approved order, resolves the adapter for the venue, applies venue
constraints (round to tick/lot, clamp to min notional), submits, and records the
venue order ID **before** the network call returns — so a crash mid-submit cannot
orphan an order. Re-checks HALT immediately before send (INV-6). Idempotency key
on `(decisionId, rungIndex)` prevents double-submission after a restart.

### 3.3 Broker adapters

Three implementations of one interface (§ 6.1 of the requirements):

| Adapter | Venue | Fills via | Notes |
|---|---|---|---|
| `AlpacaPaperAdapter` | `paper-api.alpaca.markets` | WS `trade_updates` | US equities + crypto. Free, real-time, global signup. **IEX data, not SIP** — disclosed in UI |
| `BinanceTestnetAdapter` | Binance Spot Testnet via CCXT | CCXT `watchOrders` | `setSandboxMode(true)` before any other call. 24/7 |
| `IndiaSimAdapter` | in-process simulator | internal event bus | Real NSE/BSE data, explicit fill model (§ 9.4). Zero SEBI surface — see requirements § 6.3 |

Every adapter passes the same conformance suite. Adding a venue is one file plus a
green test run.

### 3.4 Position Ledger

Source of truth for positions, lots, and blended average cost. Lot-level
accounting (FIFO default, specific-ID supported) because the trim leg needs to
sell *highest-cost lots first*, and because average cost alone hides realised P&L.

Reconciled against the venue every 60 s. Any divergence raises
`RECONCILIATION_BREAK`, emails immediately, and blocks new orders for that venue
until resolved. A ledger that silently disagrees with the broker is worse than no
ledger.

---

## TIER 4 — MONITORING

### 4.1 Monitor

Mostly code. Every open position carries **watch conditions** generated from its
thesis — this is InvestSkill's `Thesis Invalidation` / `Re-run this analysis when`
block turned into database rows:

| Condition | Default | Fires |
|---|---|---|
| `PRICE_MOVE` | ±15% from decision price | re-cycle |
| `STOP_TOUCHED` | plan stop | exit + email |
| `TARGET_TOUCHED` | each target rung | trim + email |
| `RUNG_FILLED` | any ladder rung | re-cycle (cheap) |
| `EARNINGS_NEAR` | T−3 days | re-cycle |
| `TIME_STOP` | plan time budget (default 2 quarters) | re-cycle |
| `REGIME_FLIP` | ADX crosses 25/30 | re-cycle |
| `THESIS_BREAK_*` | one row per clause the Planner wrote | escalate + email |
| `STALE` | 60 days since last cycle | re-cycle |

Price conditions are evaluated on every tick; the rest on a 5-minute cadence. A
fired condition re-enters the scheduler with the condition as the trigger reason,
so the new cycle's agents know *why* they were woken.

### 4.2 Notifier

Outbox pattern — the notification row is written **in the same transaction** as
the state change it describes (INV-7). A separate worker drains the outbox, sends
via Resend, records `providerMessageId`, and retries with backoff into a
dead-letter queue. A send failure never blocks or reverses a trade; it surfaces on
the dashboard.

Trade email contents per FR-6.2. Digest rules per FR-6.4 — but rejections, risk
breaches, reconciliation breaks, and kill-switch events **always** send
individually, never digested.

### 4.3 Reflector — the learning loop

`claude-haiku-4-5`. Runs when a position closes, and at 30-day marks for open ones.
Adopted directly from `TradingAgents/graph/reflection.py`, whose design we could
not improve on:

> Write exactly 2–4 sentences of plain prose. (1) Was the directional call
> correct? — cite the alpha figure. (2) Which part of the thesis held or failed?
> (3) One concrete lesson for the next similar analysis.

Critically, it is given **raw return AND alpha vs the benchmark**. A +8% trade in a
+12% market is a failure, and a reflection that does not know the benchmark will
record it as a success. Getting this wrong would poison the memory.

Reflections are stored append-only per symbol and injected into
`ContextPacket.memory` on future cycles. That is the entire learning mechanism —
no fine-tuning, no weights, just the system reading its own scar tissue.

### 4.4 Evaluator

Deterministic. Computes FR-8.1 metrics against FR-8.2 benchmarks and produces
FR-8.3 attribution.

**The chart that matters:** realised return bucketed by Auditor confidence tier.
If VERY HIGH-confidence decisions do not outperform LOW-confidence ones, the
Auditor is decorative and the whole pipeline is expensive theatre. That plot is
the project's core scientific output, and we should be willing to read it honestly.

Applies the § 9.4 slippage and cost model on top of every venue's fills so all
three markets are comparable, and so paper results are not flattered.

---

## 5. Cross-cutting mechanics

### 5.1 Failure handling per agent

| Failure | Handling |
|---|---|
| Schema validation fails | Retry once with the validation error appended; then mark the dimension `dataGap` and continue with the remaining analysts |
| Analyst times out | Continue with the rest; the composite **reweights proportionally** and the Auditor is told which dimension is missing (it will dock Data Quality) |
| Auditor fails | **Fail closed** — no order. Never assume a passing score |
| Planner fails | Fall back to a single sized entry at the PM's approved size, or no order if that is unavailable |
| PM fails | No order. There is no fallback for the final authority |
| Broker rejects | Persist the reject, email immediately, do not auto-retry (an auto-retry loop against a rejecting venue is how you get rate-limited and then banned) |
| LLM 429/5xx | SDK retry with backoff; after exhaustion, the cycle is abandoned and logged — never partially executed |

### 5.2 Reproducibility

`temperature: 0` on every decision agent. Every call records model ID, prompt
version, rubric version, and packet hash. Given a `packetHash` and the recorded
versions, a cycle is replayable — which is what makes a disagreement about a past
trade resolvable rather than a memory contest.

### 5.3 Cost control

Prompt caching on the shared packet and on stable system prompts. Triage before
full cycles. Haiku for high-frequency rubric work, Opus only where judgement is
the product. Per-agent cost recorded on every call and rolled up per cycle, per
day, per month, with a hard cap and auto-halt (NFR-5).

### 5.4 What is deliberately NOT an agent

Risk limits. Position accounting. Order routing. Reconciliation. Benchmark maths.
Session calendars. Fill simulation.

All of these are code, because all of them have a right answer, and an LLM's job
is judgement under uncertainty — not arithmetic with a known result. Every hour
spent making an LLM do one of these is an hour spent building something less
reliable than a `for` loop.

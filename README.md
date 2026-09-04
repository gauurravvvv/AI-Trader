# AI-Trader

**Aegis** — a multi-agent, real-time, **paper-money** trading research platform for
US equities, crypto, and Indian equities. Claude agents read SEC filings and news,
score the surprise, audit their own reasoning, clear a deterministic risk gate, and
place simulated orders. Terminal logs, a live dashboard, and a notification on every
trade action.

It runs on **Claude Code**, not on an API key. Agents shell out to the `claude` CLI
already installed on your machine.

> ### Paper money only
> There is no code path to a funded account, and that is enforced architecturally
> rather than by convention — a frozen endpoint allowlist, a boot-time assertion
> that rejects any `TRADING_MODE` other than `paper`, and a test that fails the
> build if a live broker hostname appears anywhere in source (INV-1).
>
> This is **educational and research software**. It is **not financial advice**, it
> does not manage money, and nothing here claims these agents are profitable. See
> [what this can and cannot promise](#what-this-can-and-cannot-promise).

**Status:** running. 15 packages, ~7.9k lines of source, 408 tests. Six agents
across two simulated venues. What is not built is listed
[below](#what-is-not-built), not hidden.

---

## Quickstart

No API keys. No broker signup. No market-data account.

```bash
corepack enable pnpm
pnpm install
cp .env.example .env          # defaults work as-is

pnpm dev                      # SHADOW: decides and logs, places nothing
pnpm dev -- --autonomy AUTO   # places simulated orders
```

Then open <http://localhost:3777>.

```bash
pnpm report        # did any of this beat buy-and-hold?
pnpm smoke:news    # one live news sweep: real feed, real model, no orders
pnpm test          # 408 tests
pnpm typecheck
```

**Start in SHADOW.** It runs the entire pipeline — filings, consensus, scoring,
audit, risk — and stops at the last step. Watch a few decisions you would have
disagreed with before letting it place anything.

Useful flags: `--verbose` (adds debug chatter), `--agent <name>` (filter the log to
one agent), `LOG_LEVEL=warn` (quiet), `DASHBOARD_PORT`, `STARTING_CASH`.

---

## What it costs to run

Anthropic bills programmatic Claude usage (`claude -p`, which is what this uses)
from a **separate monthly pool** to your chat usage: roughly $20 on Pro, $100 on
Max 5×, $200 on Max 20×. It does not roll over and it stops hard when exhausted.

So the budget is a first-class component, not an afterthought:

| Tier | Trigger | What stops |
|---|---|---|
| `NORMAL` | < 70% | nothing |
| `CONSERVE` | ≥ 70% | discretionary research — the news scout stands down |
| `ESSENTIAL` | ≥ 85% | new entries — nothing new is opened |
| `RULES_ONLY` | ≥ 95% | all model calls |

**Exits, stops, trailing stops and the kill switch never stop.** They are
deterministic code and never needed the model. Running out of credit must not leave
an open position unmanaged, and a test asserts exactly that.

Measured on this machine: a news triage tick is ~$0.003; an earnings read plus
audit is a few cents. Model latency is 6–90s per call, which is why nothing here
assumes a fast round trip.

---

## The system as built

```
  EDGAR 8-K (Item 2.02)          Yahoo news search
          │                              │
   edgar-poller                     news-scout ── haiku, one batched call
          │  filing_8k                   │  news_signal
          ▼                              ▼
   earnings-reader                  news-trader
   · Yahoo consensus → SUE          · already-priced?  · contradicted?
   · sonnet reads the exhibit       · category tradeable?
   · surprise-scorer                (no model — triage already paid for it)
   · thesis-auditor ── below floor? STOP
          │                              │
          └──────────────┬───────────────┘
  ══════════════════════ LLM boundary ══════════════════════
                         ▼
              RISK OFFICER (12 gates, pure code) ── breach? REJECT
                         ▼
                    Order Router  ── idempotent on (decision, rung)
                         ▼
         SimAdapter ─ sim-us (US hours) · sim-crypto (24/7)
                         ▼
       Ledger · guardian:sim-us · guardian:sim-crypto
                         ▼
        Notifier (outbox) · Dashboard (SSE) · Evaluator
```

Intelligence decreases and determinism increases as you approach the money. Risk
limits are code, never an LLM: one that hallucinates a support level costs you a
mediocre entry; one that hallucinates a position limit costs you the account.

### The six agents

| Agent | Model | What it does |
|---|---|---|
| `edgar-poller` | none | Sweeps SEC EDGAR for earnings 8-Ks across the US universe, per-CIK cursor so a filing is read once |
| `earnings-reader` | sonnet | Reads the EX-99.1 press release, extracts guidance/tone/hedging, scores it against Yahoo consensus |
| `news-scout` | haiku | One batched triage call over fresh headlines for all 23 symbols — the only alpha source that reaches crypto and India |
| `news-trader` | none | Deterministic gate from headline to order |
| `guardian:sim-us` | none | Stop loss, take profit, trailing stop, time stop |
| `guardian:sim-crypto` | none | Same, on a book that never closes |

Two of the six spend money. Four are arithmetic.

---

## Venues — simulated, zero signup

The original plan used Alpaca Paper and Binance Testnet. Both need accounts, so the
default is now a local simulator fed by live Yahoo quotes — the system runs the
moment you clone it.

| Market | Venue | Session | Costs modelled |
|---|---|---|---|
| US equities | `sim-us` | 09:30–16:00 New York | 8bp slippage floor for the IEX/SIP gap on a free feed |
| Crypto | `sim-crypto` | always | 10bp taker |
| India | `sim-india` | 09:15–15:30 Kolkata | brokerage + STT + exchange + GST + stamp, blended, plus ₹20 flat |

`sim-india` exists and is **not wired to an agent**. India is scouted for news and
not traded; the boot log says so.

The simulator is deliberately pessimistic. Every fill pays the spread, a slippage
floor, and a superlinear market-impact term, and no fill is ever dated at the
decision price. A simulator that flatters you is not a simulator.

Exchange **holidays are not modelled** — a holiday looks like a normal session.
`HOLIDAYS_MODELLED = false` says so in code.

---

## What is not built

Named because a README that only lists what works is a sales page.

- **India is scouted, not traded.** No agent routes to `sim-india`.
- **No Reflector.** The system does not learn from its own closed trades. The
  Evaluator measures; nothing feeds the measurement back.
- **No Filing Reader, Screener, or Earnings Calendar agent.** The universe is a
  hand-written list of 23 names; nothing anticipates an upcoming report.
- **No short selling.** A bearish news signal is logged and stood aside from.
- **Crypto has no alpha source of its own** beyond news. There is no on-chain,
  funding-rate, or flow signal.
- **`thesis_break` is written on every decision and never read back.** The exit
  rules are mechanical and do not check whether the thesis actually broke.
- **Run-to-run variance is real.** `claude -p` exposes no temperature control; the
  same filing scored 1.72 and 1.28 on consecutive runs.
- **No soak test.** Thirty days of wall-clock cannot be compressed, and until it
  has run there is no track record — only a system that works.

---

## Layout

```
AI-Trader/
├── apps/daemon/               the process you run — main, report, smoke:news
├── packages/
│   ├── config   db   logger   claude   budget   agents      foundation
│   ├── brokers  marketdata  edgar                            data + venues
│   ├── alpha    pipeline    risk    ledger                   the trading loop
│   └── notify   dashboard                                    output
├── docs/                      design, requirements, roadmap
├── reference/                 vendored OSS, read-only — see reference/MANIFEST.md
└── scripts/sync-reference.sh  reproducible re-clone at pinned SHAs
```

Nothing under `reference/` is imported, linked, or compiled into the application.
`openalgo` is **AGPL-3.0** — it may be *run* as a separate self-hosted service,
never linked. Pinned SHAs: [`reference/MANIFEST.md`](reference/MANIFEST.md).

### Docs

| Doc | What it answers |
|---|---|
| [`docs/superpowers/specs/2026-09-03-aegis-design.md`](docs/superpowers/specs/2026-09-03-aegis-design.md) | **Authoritative design** — CLI runtime, metered budget, the post-earnings-drift alpha engine |
| [`docs/00-RESEARCH-BRIEF.md`](docs/00-RESEARCH-BRIEF.md) | What was mined from six OSS sources and which pattern came from each |
| [`docs/01-REQUIREMENTS.md`](docs/01-REQUIREMENTS.md) | Scope, the eight invariants, data model, acceptance criteria |
| [`docs/02-AGENT-ARCHITECTURE.md`](docs/02-AGENT-ARCHITECTURE.md) | The full 16-agent design, of which six are built |
| [`docs/03-ROADMAP.md`](docs/03-ROADMAP.md) | Phases, gates, risk register |

Docs 01–03 describe the **designed** system. This README describes the **built**
one. Where they disagree, this README is right.

---

## The alpha, and why it might not be there

The US engine trades **post-earnings-announcement drift**, specifically the
text-based variant (PEAD.txt): the drift that follows the *language* of an earnings
release rather than the number. Classic numeric PEAD has decayed towards zero as it
became widely known; the text-based effect has held up better in the literature and
is strongest in names with lower institutional ownership.

The universe here is US mega-caps, which is where the effect should be *weakest* —
chosen because free data is most reliable there. That is a deliberately conservative
starting point, not the theoretically optimal one.

Three things are built in rather than disclaimed:

- **There is no published evidence that LLM agents have an edge in liquid markets.**
  StockBench (ICLR 2026) found most fail to beat buy-and-hold. A survey of 77
  agentic-trading studies found 0 of 19 reproducible.
- **Paper trading flatters you.** No queue position, no market impact, no partial
  fills, and a free US feed is single-exchange. Costs are modelled explicitly so the
  gap stays visible.
- **The deliverable is a verdict, not a bankroll.** `pnpm report` compares against
  buy-and-hold and refuses to render an opinion under twenty closed trades. If the
  honest answer is "buy-and-hold won", it says so in those words — and that is a
  successful experiment run in paper money.

---

## Licensing

Original work — `apps/`, `packages/`, `docs/`, `scripts/`, this README — is **MIT**
([LICENSE](LICENSE)).

Everything under `reference/` is an unmodified third-party copy under its own
upstream licence, including one that is **AGPL-3.0**. None of it is imported,
linked, or compiled into the original work; the relationship is mere aggregation.
Full breakdown: [NOTICE.md](NOTICE.md).

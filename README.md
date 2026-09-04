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

**Status:** running. 15 packages, ~10k lines of source, 567 tests. Eleven agents
across three simulated venues. Every phase of the roadmap is built except the
30-day soak, which is wall-clock and cannot be compressed. What is still missing
is listed [below](#what-is-not-built), not hidden.

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
pnpm report        # did any of this beat buy-and-hold, or a coin flip?
pnpm smoke:news    # one live news sweep: real feed, real model, no orders
pnpm smoke:cost    # prove what a model call costs on your machine
pnpm test          # 567 tests
pnpm typecheck
```

**Start in SHADOW.** It runs the entire pipeline — filings, consensus, scoring,
audit, risk — and stops at the last step. Watch a few decisions you would have
disagreed with before letting it place anything.

### The soak

The last roadmap phase is 30 days of unattended running, and it is the only one
that cannot be written faster.

```bash
pnpm soak                          # 30 days, SHADOW, restarts on crash
pnpm soak -- --autonomy AUTO       # places simulated orders
pnpm soak -- --days 7              # shorter window

tail -f .soak/soak.log             # watch it
kill "$(cat .soak/soak.pid)"       # stop it, daemon included
pnpm report                        # the verdict
```

Budget it before you start: at the default 20-minute news cadence this is
roughly **$1–2 of metered credit per day**, so a full 30-day run is a
meaningful share of a $100 monthly pool. `NEWS_INTERVAL_MIN` is the dial.

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

### What a call actually costs, and why the flags matter

`claude -p` loads Claude Code's own system prompt on every invocation — every MCP
server's tool schemas, every built-in tool, and per-machine sections like cwd and
git status. It is billed as input, and it dwarfs anything you send.

Measured on this machine, steady state per trivial haiku call:

| Configuration | Cost |
|---|---|
| default, no flags | **$0.130** |
| `--strict-mcp-config` | $0.0043 |
| `+ --disallowed-tools` | $0.0034 |
| `+ --system-prompt` | **$0.0028** |

A 47× difference, none of it about our prompt. The default configuration is the
worst case because the per-machine sections change between runs, so it invalidates
its own cache on every call and pays creation price forever. Aegis passes all
three flags; `pnpm smoke:cost` proves it on your machine.

Real measured costs: a news sweep is **$0.0146**, an earnings read plus audit is a
few cents. `NEWS_INTERVAL_MIN` is the biggest lever on the monthly bill — every 10
minutes is ~$63/month, every 20 is ~$31. Latency is 3–90s per call, so nothing here
assumes a fast round trip.

Cost is read from the CLI's own `total_cost_usd`, not estimated from token counts.
Estimating understated the real bill by more than two orders of magnitude.

---

## The system as built

```
  EDGAR 8-K (Item 2.02)              Yahoo news search
          │                                  │
   edgar-poller                         news-scout ── haiku, one batched call
          │  filing_8k                       │  news_signal
          ▼                                  ▼
   earnings-reader                      news-trader
   · Yahoo consensus → SUE              · already-priced?  · contradicted?
   · sonnet reads the exhibit           · category tradeable?
   · surprise-scorer                    (no model — triage already paid for it)
   · thesis-auditor ── below floor? STOP
          │                                  │
          └────────────────┬─────────────────┘
                           ▼
              execution-planner ── rungs sized by conviction
  ════════════════════════ LLM boundary ════════════════════════
                           ▼
            RISK OFFICER (13 gates, pure code) ── breach? REJECT
                           ▼
                      Order Router ── idempotent on (decision, rung)
                           ▼
      SimAdapter ─ sim-us · sim-crypto · sim-india   (fills worked in slices)
                           ▼
     Ledger · provenance · 3 × guardian · 3 × ladder
                           ▼
   Notifier · Dashboard (SSE) · Evaluator · Reflector
```

Intelligence decreases and determinism increases as you approach the money. Risk
limits are code, never an LLM: one that hallucinates a support level costs you a
mediocre entry; one that hallucinates a position limit costs you the account.

### The eleven agents

| Agent | Model | What it does |
|---|---|---|
| `edgar-poller` | none | Sweeps SEC EDGAR for earnings 8-Ks, per-CIK cursor so a filing is read once |
| `earnings-reader` | sonnet | Reads the EX-99.1 release, scores guidance/tone/hedging against Yahoo consensus |
| `news-scout` | haiku | One batched triage call over fresh headlines for all 23 symbols |
| `news-trader` | none | Deterministic gate from headline to order |
| `reflector` | haiku | Reads closed trades, records what to do differently — judged on alpha |
| `guardian:*` ×3 | none | Stop, target, trailing stop, time stop, **and the recorded thesis** |
| `ladder:*` ×3 | none | Walks staged entries one rung per tick |

Three of the eleven spend money. Eight are arithmetic.

### What each entry records

Every decision carries its sources — the filing accession and date, when the
consensus was fetched, the quote and its timestamp, the news story and publisher.
Inputs that are weaker than they look (a synthesised spread, a fallback SUE
basis) are flagged `degraded`, so "which trades were priced off a made-up
spread" is a query rather than a memory. The dashboard marks those decisions.

Entries are staged rather than sent whole. Conviction decides the shape: a
high-conviction read takes 70% immediately because waiting costs more than it
saves; a marginal one probes with 40% and adds only if the market does not
disagree. Each rung has a price ceiling, and the ladder abandons the remainder
when price runs past it — a ladder without a ceiling is a slower way to buy a
breakout at the top.

Exits check the **recorded thesis** before the price rules. A position whose
reason for existing has been falsified — the next report landed, or a material
story pointed the other way — is closed on that basis rather than held until it
happens to hit a stop.

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

All three are traded. The simulator is deliberately pessimistic: every fill pays
the spread, a slippage floor, and a superlinear market-impact term; no fill is
ever dated at the decision price; and an order above 0.5% of bar volume is worked
in slices, each priced on the quantity already worked. A simulator that flatters
you is not a simulator.

The **PDT rule** is enforced on US equities — four same-day round trips in five
sessions below $25,000 equity and the fourth is refused. It is the only rule in
the system that can block a sell, so it is scoped to same-day round trips only,
and never applies to crypto or India.

Exchange **holidays are modelled** for both equity venues through 2027, resolved
in the exchange's own timezone. The lists are finite and the daemon warns at boot
once they run out. **Half-days are not modelled** — an early close reads as a full
session, and `HALF_DAYS_MODELLED = false` says so in code.

---

## What is not built

Named because a README that only lists what works is a sales page.

- **No 30-day soak has run.** This is the last roadmap phase and the only one
  that cannot be written: it is wall-clock. Until it finishes there is no track
  record, only a system that works.
- **No short selling.** A bearish signal is recorded and stood aside from; the
  venues declare no short support.
- **Crypto has no alpha source of its own** beyond news — no on-chain, funding
  rate, or flow signal.
- **India rarely has tradeable news.** Yahoo's search returns nothing
  attributable for most NSE symbols, and the scout correctly emits nothing
  rather than passing on unrelated stories. The venue works; the data is thin.
- **Half-days and post-2027 holidays are not modelled.**
- **Run-to-run variance is real.** `claude -p` exposes no temperature control;
  the same filing scored SUE 1.72 and 1.28 on consecutive runs.
- **The Reflector's lessons are recorded, not applied.** Nothing yet reads them
  back to change a threshold — that is a human decision on purpose, and the
  report ranks categories by the alpha they cost so it is an informed one.

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

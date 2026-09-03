# AI-Trader

**Aegis** — a multi-agent, real-time, **paper-money** trading research platform for
US equities, Indian equities, and crypto. Claude agents research each name, argue
it from both sides, audit their own reasoning, plan a staged entry, clear a
deterministic risk gate, and place orders against paper accounts. Email on every
trade action; live TradingView charts.

> ### Paper money only
> There is no code path to a funded account, and that is enforced
> architecturally rather than by convention — a frozen endpoint allowlist, a
> boot-time assertion, and a test that fails the build if a live broker hostname
> appears anywhere in source (INV-1).
>
> This is **educational and research software**. It is **not financial advice**,
> it does not manage money, and nothing here should be read as a claim that these
> agents are profitable. See [what this can and cannot promise](#what-this-can-and-cannot-promise).

**Status:** planning complete, no application code yet. Phase 0 is next.

---

## Read in this order

| Doc | What it answers |
|---|---|
| [`docs/00-RESEARCH-BRIEF.md`](docs/00-RESEARCH-BRIEF.md) | What we mined from six sources and exactly which pattern we took from each |
| [`docs/01-REQUIREMENTS.md`](docs/01-REQUIREMENTS.md) | Scope, hard invariants, functional/non-functional requirements, venues, data model, key decisions, acceptance criteria |
| [`docs/02-AGENT-ARCHITECTURE.md`](docs/02-AGENT-ARCHITECTURE.md) | **How every agent works** — research → planning → execution → monitoring, with contracts, rubrics, and failure modes |
| [`docs/03-ROADMAP.md`](docs/03-ROADMAP.md) | Ten phases, gates, estimates, and the risk register |
| **[`docs/superpowers/specs/2026-09-03-aegis-design.md`](docs/superpowers/specs/2026-09-03-aegis-design.md)** | **Current authoritative design** — Claude Code CLI runtime, metered budget, the post-earnings-drift alpha engine, 16-agent roster. Supersedes parts of 01–03. |
| [`docs/superpowers/plans/2026-09-03-phase-0-1-foundation-and-broker-spine.md`](docs/superpowers/plans/2026-09-03-phase-0-1-foundation-and-broker-spine.md) | Task-by-task TDD plan for Phases 0–1, ready to execute |

A shareable visual overview lives at [`docs/assets/architecture-overview.html`](docs/assets/architecture-overview.html), published at <https://claude.ai/code/artifact/1fd620b5-182c-4d01-8798-e7df66909cfd> (private until you share it).

---

## Layout

```
AI-Trader/
├── README.md  LICENSE  NOTICE.md
├── docs/                      the plan (read these first)
│   └── superpowers/plans/     executable task-by-task implementation plans
├── reference/                 vendored OSS, read-only — see reference/MANIFEST.md
│   ├── TradingAgents/         Apache-2.0 · agent topology, debate control flow, reflection loop
│   ├── ai-hedge-fund/         MIT · investor-persona agents
│   ├── openalgo/              AGPL-3.0 ⚠️ NEVER LINKED · Indian broker landscape
│   ├── AgenticTrading/        OpenMDW-1.0 · evaluation discipline
│   ├── InvestSkill/           MIT · 26 analysis frameworks v1.11.0 (prompt-only)
│   └── ai-trading-claude/     MIT · 16 Claude skills, 5 agent specs (prompt-only)
└── scripts/
    └── sync-reference.sh      reproducible re-clone of all six at pinned SHAs
```

All six live under `reference/` with their `.git` stripped, so this workspace is a
single self-contained tree — provenance is the pinned SHA in the manifest, and
`scripts/sync-reference.sh` re-clones from it. Nothing under `reference/` is
imported, linked, or compiled into the application. `openalgo` is AGPL-3.0 — it may
be *run* as a separate self-hosted HTTP service, never linked. Details and pinned
SHAs: [`reference/MANIFEST.md`](reference/MANIFEST.md).

---

## The system in one diagram

```
 TRIGGER → Triage → ContextPacket ─┬→ Technical  ─┐
                                   ├→ Fundamental │
                                   ├→ Sentiment   ├→ Bull ⇄ Bear debate
                                   ├→ News        │        ↓
                                   └→ Macro      ─┘   Risk trio debate
                                                           ↓
                                                       AUDITOR ──── below floor? STOP
                                                           ↓
                                                   Execution Planner
                                                           ↓
                                                   Portfolio Manager
   ═══════════════════════════════════════════════════════ LLM boundary ═══
                                                           ↓
                                                   RISK OFFICER (code) ── breach? REJECT
                                                           ↓
                                              Order Router → BrokerAdapter
                                                           ↓
                                        Ledger · Notifier(email) · Monitor
                                                           ↓
                                          Evaluator · Reflector → memory
```

Intelligence decreases and determinism increases as you approach the money. Risk
limits are code, never an LLM — an LLM that hallucinates a support level costs you
a mediocre entry; one that hallucinates a position limit costs you the account.

---

## Venues — all paper, all behind one adapter

| Market | Venue | Ships | Why |
|---|---|---|---|
| Crypto | Binance Spot Testnet | 1st | Open 24/7, so the real-time loop can be debugged at 11pm on a Sunday rather than waiting for Monday's open |
| US equities | Alpaca Paper | 2nd | Free, real-time, global signup. Free tier serves IEX rather than consolidated prices, so US fills carry an extra slippage penalty |
| India | In-house simulator | 3rd | No Indian broker offers a real paper sandbox, and SEBI's algo framework has required static-IP whitelisting, a registered strategy ID and exchange empanelment since 2026-04-01. Simulating keeps the regulatory surface at zero; the adapter interface keeps a real broker a drop-in later |

All three implement the same `BrokerAdapter` and pass the same conformance suite,
so agent code never knows which venue it is talking to.

---

## What this can and cannot promise

No design guarantees profit, and one that assumes it is the design that loses
money. Three things are built into the requirements rather than bolted on as
disclaimers:

- **There is no published evidence that LLM agents have an edge in liquid
  markets.** Every framework this draws from — including the two most-starred on
  GitHub — ships research-only with no audited track record.
- **Paper trading flatters you.** No queue position, no market impact, and on the
  free US tier, single-exchange prices. Slippage and costs are modelled explicitly
  on all three venues so the gap stays visible.
- **The v1 deliverable is a verdict, not a bankroll.** Does the pipeline beat
  buy-and-hold after modelled costs, with enough closed trades to believe it? If
  the honest answer is no, that is a successful experiment run in paper money.

---

## Licensing

Original work here — `docs/`, `scripts/`, `README.md`, and any application code —
is **MIT** ([LICENSE](LICENSE)).

Everything under `reference/` is an unmodified third-party copy under its own
upstream licence, including one that is **AGPL-3.0** (`reference/openalgo/`). None
of it is imported, linked, or compiled into the original work; the relationship is
mere aggregation. Full breakdown and the AGPL handling rule: [NOTICE.md](NOTICE.md).

---

## Open questions

Seven decisions that change the work — starting capital, risk budget, universe,
holding horizon, LLM budget, email target, deploy target — are listed in
[requirements § 12](docs/01-REQUIREMENTS.md), each with a working default already
in effect, so nothing is blocked on them.

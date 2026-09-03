# AI-Trader — single source of truth

Workspace for **Aegis**: a multi-agent, real-time, **paper-money** trading research
platform covering US equities, Indian equities, and crypto — with email alerts on
every trade action and live TradingView charts.

> **Paper money only.** There is no code path to a funded account, and that is
> enforced architecturally, not by convention. See INV-1 in the requirements.
> Educational and research use. Not financial advice.

---

## Read in this order

| Doc | What it answers |
|---|---|
| [`docs/00-RESEARCH-BRIEF.md`](docs/00-RESEARCH-BRIEF.md) | What we mined from six sources and exactly which pattern we took from each |
| [`docs/01-REQUIREMENTS.md`](docs/01-REQUIREMENTS.md) | Scope, hard invariants, functional/non-functional requirements, venues, data model, key decisions, acceptance criteria |
| [`docs/02-AGENT-ARCHITECTURE.md`](docs/02-AGENT-ARCHITECTURE.md) | **How every agent works** — research → planning → execution → monitoring, with contracts, rubrics, and failure modes |
| [`docs/03-ROADMAP.md`](docs/03-ROADMAP.md) | Ten phases, gates, estimates, and the risk register |
| [`docs/superpowers/plans/2026-09-03-phase-0-1-foundation-and-broker-spine.md`](docs/superpowers/plans/2026-09-03-phase-0-1-foundation-and-broker-spine.md) | Task-by-task TDD plan for Phases 0–1, ready to execute |

A shareable visual overview lives at [`docs/assets/architecture-overview.html`](docs/assets/architecture-overview.html), published at <https://claude.ai/code/artifact/1fd620b5-182c-4d01-8798-e7df66909cfd> (private until you share it).

---

## Layout

```
AI-Trader/
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

## Status

Planning complete. No application code yet — Phase 0 is the next step.

**Venues (all paper):** Binance Spot Testnet (crypto, ships first — 24/7 means you
can debug the real-time loop at 11pm on a Sunday) · Alpaca Paper (US) · in-house
simulator (India — chosen because SEBI's algo framework, fully in force since
2026-04-01, makes a real Indian broker adapter a compliance project rather than an
integration; the adapter interface keeps it a drop-in later).

**Open questions** that change the work are listed in
[requirements § 12](docs/01-REQUIREMENTS.md) with defaults already in effect.

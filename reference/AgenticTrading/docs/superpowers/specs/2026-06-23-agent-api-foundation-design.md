# Agent-facing API Foundation (Plan 2) — Design Spec

- **Date:** 2026-06-23
- **Owner:** Felix (FlyMiss)
- **Repo:** agent-trading-lab
- **Status:** Design — approved, ready for implementation plan
- **Programme:** Plan 2 of 3 (Plan 1 = news→sentiment signal over the feed; Plan 3 = benchmark Agentic FinSearch as an agent)
- **Charter:** `Trade Materials/ATL-Agent-API-Foundation-Plan2-Charter.html`

## 1. Goal

Turn the lab's current, implicit external-agent API into a **deliberate, documented, MCP-aligned API foundation** that any agent (Claude / GPT / Cursor / FinSearch) can target — register, fetch context (market + news + sentiment), submit decisions, get results — with versioning, auth/governance, and benchmark/leaderboard hooks.

This is **formalize-and-unify**, not rebuild. The existing surface (`POST /api/v1/agents` → `POST /api/v1/backtest/start` → poll `…/steps/current` → `POST …/decisions`) is ~80% of the contract already; the work is to give it a typed/versioned context schema (incl. Plan 1's `news_sentiment`), a documented decision/error model, scoped + rate-limited auth, schema-level backtest/paper parity (backtest execution in v1; paper designed-for), benchmark hooks, and an MCP-ready shape.

### The hard boundary (unchanged)

The **agent's LLM runs client-side.** The backend serves context and validates decisions; it never calls the agent's model. "Feeding news to an agent" means putting news in the served context envelope. `llm_validator.py` remains a hard security boundary: decision payloads are JSON-only; `tool_calls`/`function_calls` are rejected. The MCP façade (Phase C) never loosens this.

## 2. Resolved design decisions

| Fork | Decision | Rationale |
|---|---|---|
| **v1 shape / ambition** | REST is the source of truth; the surface is **MCP-shaped**; the actual MCP server is **deferred to Phase C**. | Freeze the contracts first; the later MCP server is a thin, mechanical adapter over frozen REST. |
| **Versioning** | New **`/api/v2/*`** namespace; existing `/api/v1/*` left untouched. | The agent contract becomes its own governed, documented, independently-deprecatable surface. |
| **Universe** | DJIA-30 stays the only tradable universe, but is a **declared, typed `universe` field** in the context + run config — not an implicit constant. | Matches Plan 1's DJIA-30 ∩ watchlist constraint; parameterizing later is a flip, not a rewrite (YAGNI). |
| **Mode parity** | v1 **ships backtest execution only.** The contract is defined at the **schema level** (context/decision/result) so it is mode-independent, but **paper and live execution are designed-for, not built** — see §4.2 and the design-review finding below. | Schema-level parity is what lets Plan 3 benchmark in backtest and later run identical client code against paper. Paper has **no execution path in the codebase today** (read-only Alpaca client, no order submission, no step loop), so `PaperBackend` is real new work that needs its own design pass, not a wrapper. |

> **Design-review correction (2026-06-23).** The first draft framed paper parity as "wrap the existing paper client behind the same backend." Grounding against the code disproved that: `AlpacaPaperTradingClient` is read-only and there is no order-submission or step-loop path for paper. Paper trading is **wall-clock-driven**, not the agent-driven lockstep the backtest uses, so the step/`decision_deadline_at`/auto-hold lifecycle does **not** translate. Decision (per Felix): **ship Phase A (backtest) as the committed v1 deliverable; re-design paper as Phase B when we reach it.** The `ExecutionBackend` abstraction and schema-level parity stay; `PaperBackend`/`LiveBackend` become designed-for stubs.
| **Transport** | **Polling**, SSE-ready. | Maps cleanly onto MCP's request/response tool model; the backtest loop is inherently lockstep. Optional SSE push is a later add for live dashboards. |
| **Auth depth** | Existing `ag_` key **+ per-agent rate-limit + basic scopes**. | Pragmatic governance without an OAuth build-out; protects the backend and enables the "do agents herd?" fairness experiment. |

## 3. The two shared contracts (couple the plans)

### 3.1 Sentiment-signal contract (from Plan 1 → graduated here into a typed field)

```jsonc
news_sentiment[SYM] = {
  "sentiment": "bullish" | "bearish" | "neutral",
  "score": -1.0..1.0,
  "headline": "…", "source": "Reuters", "url": "https://…",
  "age_hours": 3.2, "n_articles": 2
}
news_overview = "market-wide one-liner"
```

**Composition boundary:** Plan 2 *types and guarantees the slot*; Plan 1's adapter (`integrations/news_sentiment.py`) *populates it*. The `news_sentiment` key is **always present** in the context envelope (fail-closed to `{}`, `news_overview` to `null`) so agents can rely on it existing even before Plan 1 merges. Entries are validated against a typed `NewsSentimentEntry` model, scoped to `universe`, one aggregated entry per ticker.

### 3.2 Agent-API contract (Plan 2 produces → Plan 3 consumes)

Four canonical verbs, each a single REST endpoint that maps 1:1 onto a future MCP tool of the same name:

```
register        → POST   /api/v2/agents
get_context     → GET    /api/v2/runs/{run_id}/context
submit_decision → POST   /api/v2/runs/{run_id}/decisions
get_result      → GET    /api/v2/runs/{run_id}/result
```

## 4. Architecture

### 4.1 The `/api/v2` surface

| Endpoint | Verb-role | Purpose |
|---|---|---|
| `POST /api/v2/agents` | register | Create agent → `{agent_id, api_key (ag_…), session_id, scopes}` (key shown once) |
| `GET /api/v2/agents/me` | — | Resolve caller from `X-API-Key` → identity, scopes, rate-limit status |
| `POST /api/v2/agents/{id}/rotate-key` | — | Rotate key (exists today) |
| `POST /api/v2/runs` | — | Start a run. Body: `mode: backtest` (paper deferred), `universe: djia_30`, date-range params, `agent_name`, `model_name`. **Mints the canonical `run_id` here** (see §4.3). Returns `{run_id, mode, status, loop, decision_timeout_seconds}` |
| `GET /api/v2/runs/{run_id}` | — | Run status: `{status, step_index, total_steps, decision_deadline_at, mode}` |
| `GET /api/v2/runs/{run_id}/context` | **get_context** | Typed context envelope for the current step |
| `POST /api/v2/runs/{run_id}/decisions` | **submit_decision** | `{idempotency_key, actions:[…]}` → ack |
| `GET /api/v2/runs/{run_id}/result` | **get_result** | `{metrics, equity, trades, decisions, manifest}` — feeds leaderboard |
| `GET /api/v2/runs/{run_id}/decisions` | — | Full decision log (audit / herding probe) |
| `POST /api/v2/runs/{run_id}/cancel` | — | Cancel a stuck run (→ `closed`) |
| `GET /api/v2/schema` | — | Self-describing: context schema, decision schema, universe, error codes, version |
| `GET /api/v2/leaderboard` | — | Ranked scored runs vs baselines (Plan 3 target) |

**Naming:** standardize on **`run`** as the canonical noun (the lab already says "run" everywhere — `agent_runs`, `/runs`). URLs become mode-neutral: `/runs/{id}/context` instead of `/backtest/{id}/steps/current`. Step-loop semantics preserved.

**MCP-shaping rule** held for every endpoint: one logical action, flat JSON in, self-contained JSON envelope out, fully described by `GET /schema`. Guarantees the Phase-C MCP façade is mechanical.

### 4.2 The parity mechanism — `ExecutionBackend` (two distinct kinds of parity)

The design separates two things the first draft conflated:

- **Schema parity (delivered in v1, mode-independent):** the `ContextEnvelope`, `DecisionRequest`, and `ResultEnvelope` schemas are identical regardless of mode. This is what lets Plan 3 benchmark in backtest and later reuse *identical client code* against paper.
- **Lifecycle parity (NOT universal — backend-specific):** the *loop semantics* differ by mode and are advertised via a `loop` field on the context envelope:
  - `loop: "lockstep"` (backtest) — agent advances discrete steps; `decision_deadline_at` + auto-hold-on-timeout apply.
  - `loop: "realtime"` (paper/live, **designed-for**) — wall-clock cadence; the market advances on its own; there is **no** agent-driven `advance()` and **no** auto-hold. Decisions map to live orders.

`POST /api/v2/runs` reads `mode` and instantiates an `ExecutionBackend`:

- `BacktestBackend` — **wraps** the existing `ExternalBacktestSession` / `build_market_snapshot` (not a rewrite). **Built in v1.**
- `PaperBackend` — **designed-for stub in v1.** It is *new execution code* (live Alpaca order submission, a realtime decision-cadence scheduler, live bar-fetch + indicator assembly), because no paper execution path exists today. Deferred to a Phase-B design pass.
- `LiveBackend` — designed-for, documented stub, not built.

```python
class ExecutionBackend:
    loop: str  # "lockstep" | "realtime"
    def build_context(self) -> ContextEnvelope: ...     # identical schema across backends
    def apply_decisions(self, actions) -> ExecutionResult: ...# identical ack schema across backends
    def advance(self) -> None: ...   # lockstep only; realtime backends no-op / wall-clock driven
    def status(self) -> RunStatus: ...
    def result(self) -> ResultEnvelope: ...
```

The interface is the **seam**; only `BacktestBackend` is wired in v1. `test_v2_parity` asserts schema parity (both backends' envelopes validate against the same models), not lifecycle parity.

### 4.3 Run identity — one `run_id` for the whole life

**Correctness fix from design review:** today the engine uses two ids — `backtest_id` (`bt_<uuid>`, the in-memory session handle during the loop) and `run_id` (`ext_<ts>`, the persisted DB row, created only at `_finalize()`). The first draft ambiguously called both "run_id."

v2 **mints one canonical `run_id` at `POST /api/v2/runs`** and uses it for the entire lifecycle: the in-memory session, every loop endpoint (`/context`, `/decisions`, `/status`, `/cancel`), the persisted row at finalize, and the leaderboard. The `bt_`/`ext_` split is removed. This is what makes idempotency keys (§5.2) well-defined during the loop — the key they reference exists from creation, not just at completion.

## 5. Data contracts (typed)

### 5.1 Context envelope — `GET /api/v2/runs/{run_id}/context`

Keeps today's *inner* field names (`portfolio`, `current_holdings`, `recent_trades`, `top_signals`) to make porting trivial; wraps them in a typed, versioned envelope and adds `universe` + `news_sentiment`.

```jsonc
{
  "schema_version": "2.0",
  "run_id": "…", "mode": "backtest",
  "step_index": 0, "total_steps": 48,
  "timestamp": "2026-04-15T10:30:00+00:00",
  "loop": "lockstep",                      // lockstep (backtest) | realtime (paper/live, designed-for)
  "decision_deadline_at": "…",             // present only when loop == "lockstep"
  "decision_timeout_seconds": 30,          // lockstep only
  "status": "waiting_decision",            // waiting_decision | loading | completed | closed
  "universe": ["AAPL","MSFT", …],          // DJIA-30, now EXPLICIT in the contract
  "portfolio":        { "cash":…, "positions_value":…, "total_equity":…, "num_positions":… },
  "current_holdings": { "AAPL": { "shares":…, "entry_price":…, "current_price":…, "position_value":…, "pnl_pct":… } },
  "recent_trades":    [ … ],
  "top_signals":      { "AAPL": { "price":…, "rsi":…, "macd":…, "macd_signal":…, "sma20":…, "sma50":…, "bb_upper":…, "bb_lower":… } },
  "news_sentiment":   { "AAPL": { "sentiment":"bullish", "score":0.62, "headline":"…", "source":"Reuters", "url":"https://…", "age_hours":3.2, "n_articles":2 } },
  "news_overview":    "market-wide one-liner or null",
  "decision_format":  { … }                // self-describing echo of how to respond
}
```

`status` values: `loading` (warming market data), `waiting_decision` (step open), `completed`, `closed`.

**Field scopes (design-review clarification):** `top_signals` is the engine's *curated top-10 by |rsi−50|* (not all 30 symbols), preserved as-is. `news_sentiment` is scoped to the **full `universe`** (all 30), not the `top_signals` subset — news relevance is independent of the technical-signal ranking, and an agent may want news on a symbol it isn't currently signalled on.

### 5.2 Decision contract — `POST /api/v2/runs/{run_id}/decisions`

```jsonc
{
  "idempotency_key": "uuid-v4",            // safe retries past the step_already_closed race
  "actions": [
    { "action": "buy|sell|hold", "symbol": "AAPL", "confidence": 0.0-1.0,
      "reasoning": "5-500 chars (first-class, stored, indexed for the herding probe)",
      "position_size": 0-10000, "stop_loss_price": float|null, "take_profit_price": float|null }
  ]
}
```

- **Idempotency:** server keys on `(run_id, idempotency_key)`; a replay returns the *original* ack instead of double-executing. This is well-defined because `run_id` is minted at run creation (§4.3) and is stable through the loop — it does not depend on the finalize-time id the old engine used. (Keying on `step_index` would prevent retries after step advance: the engine advances synchronously, so a retry arriving post-advance gets a new `step_index` and misses the record, re-executing. `step_index` is still *stored* as metadata, just not part of the key.)
- **`reasoning`** becomes a first-class, stored, queryable field (already persists to `trades.reason`/`backtest_decisions`; formalized so the herding probe is a query, not a scrape).
- **Security boundary unchanged:** `tool_calls`/`function_calls` → reject (`llm_validator`).
- **Validation rules carried over** from `llm_validator`: symbol ∈ `universe`; `confidence ∈ [0,1]`; `reasoning` 5–500 chars; `position_size` 0–10000; positive-or-null stop/take prices; insufficient-cash / sell-without-position / oversized-position checks.

### 5.3 Submit ack — per-action, partial execution

Submit returns `200` with a partial-execution ack — valid actions execute, invalid ones are dropped **with reasons** (more informative than today's all-or-nothing `validation_hold`). If *all* actions are invalid, the step auto-holds (safety preserved). Sub-min-confidence actions become `hold`.

```jsonc
{
  "accepted": true,
  "executed": [ { "action":"buy", "symbol":"AAPL", "shares":10, "price":505.0 } ],
  "rejected": [ { "symbol":"ZZZ", "reason":"universe_violation" } ],
  "decision_source": "external_agent",     // external_agent | timeout_hold | validation_hold
  "next_step": 1,
  "status": "waiting_decision",            // or "completed"
  "run_id": "…", "metrics": { … }          // metrics present iff completed
}
```

### 5.4 Error model — one envelope

```jsonc
{ "error": { "code": "validation_failed|step_already_closed|run_not_found|unauthorized|forbidden_scope|rate_limited|universe_violation|insufficient_cash|invalid_symbol|invalid_status",
             "message": "human-readable", "details": { … }, "retryable": true|false } }
```

Conventional statuses: `400` validation · `401` auth · `403` scope · `404` not found · `409` step closed/conflict · `422` business-rule (e.g. insufficient cash) · `429` rate limit. `GET /api/v2/schema` publishes the full code list so clients are self-correcting.

## 6. Auth, identity & governance

- **Core (unchanged):** `ag_<token>`, SHA-256-hashed, issued once, `rotate-key` exists. Caller authenticates with `X-API-Key`; the key resolves to `agent_id` + `session_id` (agents no longer juggle `X-Session-Id` — the key carries ownership). `X-Session-Id` stays accepted for the browser dashboard.
- **Scopes** (stored on the agent record; checked per endpoint; `403 forbidden_scope` on miss):
  `agents:register` · `runs:write` · `context:read` · `decisions:write` · `runs:read`.
  Default grant on registration = all five (single-tenant research default); the *machinery* is what enables governance and future MCP auth alignment.
- **Per-agent rate limiting:** token-bucket keyed on `agent_id`, env-configurable, returns `429 + Retry-After` and `X-RateLimit-Limit/Remaining/Reset` headers. Purposes: protect the backend from a runaway agent, and enforce fairness across N agents so the herding probe is a clean experiment.

## 7. Run lifecycle

```
created → loading → waiting_decision ⇄ (submit | timeout_hold → advance) → … → completed
                                                                              ↘ failed / closed
```

`POST /api/v2/runs/{id}/cancel` → `closed`. **This state machine is the `lockstep` (backtest) lifecycle** — `waiting_decision`, `decision_deadline_at`, and auto-hold-on-timeout (`EXTERNAL_AGENT_DECISION_TIMEOUT_SECONDS`, default 30) carry over from `external_backtest_service`. A future `realtime` (paper/live) backend has a *different* lifecycle (wall-clock cadence, no deadline/auto-hold) — designed-for, defined in the Phase-B pass (§4.2), not this one. The `created`/`completed`/`failed`/`closed` terminal states are shared; the middle differs by `loop`.

## 8. Benchmark / leaderboard hooks (what Plan 3 needs)

A run emits four things:

1. **Standardized metrics** in `get_result`: `{total_return, sharpe_ratio, max_drawdown, win_rate, num_trades, final_equity, llm_calls, input_tokens, output_tokens, est_cost_usd}` — same shape across modes, comparable to existing baselines (buy-hold, DJIA index).
2. **Reproducibility manifest** per run: `{agent_name, model_name, mode, universe, date_range, decision_timeout, schema_version, news_sentiment_source}`.
3. **Per-decision context provenance:** each decision-log entry stores `decision_source`, `actions_submitted`, `actions_executed`, **and a `context_ref` (hash of the exact context — incl. `news_sentiment` — the agent saw).** Turns "N agents, identical news → measure decision correlation" into a direct query, and traces every benchmarked decision to one source of truth.
4. **Leaderboard endpoint** `GET /api/v2/leaderboard` ranks scored runs against baselines (builds on existing `leaderboard.py`/`baselines*.py`, replacing partly-mock data with real v2 runs).

## 9. File map

Honors the repo's flat-import rule: backend root has **no** `__init__.py` and modules import by bare name; new packages (`api/v2/`, `execution/`) are subpackages *with* `__init__.py`, mirroring `engines/`.

```
dashboard/backend/
├── api/v2/                          # NEW versioned package (mounted at /api/v2)
│   ├── __init__.py
│   ├── router.py                    # composes the v2 sub-routers
│   ├── models.py                    # ★ THE typed contract: ContextEnvelope, NewsSentimentEntry,
│   │                                #   DecisionRequest, ActionItem, SubmitAck, ErrorEnvelope, RunManifest, ResultEnvelope
│   ├── agents.py                    # register / me / rotate-key (+ scopes)
│   ├── runs.py                      # create · status · context · decisions · result · decisions-log · cancel
│   ├── schema.py                    # GET /api/v2/schema (self-describing)
│   └── leaderboard.py               # GET /api/v2/leaderboard (real v2 runs vs baselines)
├── execution/                       # NEW package — the parity mechanism
│   ├── __init__.py
│   ├── base.py                      # ExecutionBackend interface (loop: lockstep|realtime)
│   ├── backtest_backend.py          # wraps existing ExternalBacktestSession (NOT a rewrite) — BUILT in v1
│   └── paper_backend.py             # designed-for STUB in v1 (real new code: live orders + realtime
│                                    #   cadence) — Phase-B design pass; LiveBackend likewise stubbed
├── auth_scopes.py                   # scope constants + require_scope() FastAPI dependency
├── rate_limit.py                    # per-agent token bucket
├── agent_store.py    (EXTEND: scopes column)
├── database.py       (EXTEND: idempotency table; context_ref + run_manifest; update both _init_schema & _migrate_schema)
├── llm_validator.py  (REUSE as the security boundary; DJIA_30 → the `universe` source)
└── external_backtest_service.py / paper_trading.py  (REUSE, wrapped by backends)

dashboard/examples/external_agent_client_v2.py   # NEW reference client — the v2 contract in action
docs/source/lab/agent_api.rst                     # NEW documented API surface (+ update architecture.rst)
```

`api/v2/models.py` is the centerpiece — the typed contract as Pydantic models, which also yields a clean auto-generated **OpenAPI** doc at `/openapi.json`.

## 10. Testing strategy

TDD; tests prepend the backend dir to `sys.path` per the existing pattern (`sys.path.insert(0, str(Path(__file__).parent.parent))`).

| Test file | Proves |
|---|---|
| `test_v2_contracts.py` | Models validate good payloads, reject bad (news_sentiment typing, `score ∈ [-1,1]`, decision bounds, error envelope) |
| `test_v2_runs.py` | Lifecycle create → context → decisions → result end-to-end |
| `test_v2_parity.py` | **Schema** parity: the context/decision/result envelopes validate against the same models (backtest backend in v1; the test is written so a future paper backend's envelopes must also pass) |
| `test_v2_auth.py` | Scope miss → 403, rate-limit → 429, key resolves to agent + session |
| `test_v2_idempotency.py` | Replayed `idempotency_key` returns original ack, no double-execute; `run_id` stable from creation |
| `test_execution_backends.py` | `BacktestBackend` conforms to the `ExecutionBackend` interface; `loop == "lockstep"` |

## 11. Phasing

- **Phase A — Formalize REST + typed context (the committed v1 deliverable; plan-ready now).** v2 namespace, `models.py` contract, `runs` over `BacktestBackend`, canonical `run_id` minted at creation (§4.3), typed context incl. the `loop` field and the `news_sentiment` slot, decision/idempotency/error model, scopes + rate-limits, `/schema`, benchmark hooks (manifest, `context_ref`, real `/leaderboard` over v2 runs), v2 client example + docs. *Delivers the agent-API contract Plan 3 targets, end-to-end, for backtest.*
- **Phase B — Paper parity (needs its own design pass before implementation).** Design + build `PaperBackend`: live Alpaca order submission, the `realtime` loop model, a decision-cadence scheduler, live context assembly. **Not plan-ready from this spec** — it requires a focused design (see §4.2 review correction). Pulled forward into Phase A *only* the schema-level seam that makes it droppable-in later.
- **Phase C — MCP façade (designed-for, deferred).** Thin MCP server mapping the four tools onto v2 REST; `LiveBackend`. Not built in this programme cut, but every contract above is shaped so it's mechanical.

> Note: governance (scopes + rate-limits) and benchmark hooks moved **into Phase A** — they're additive over backtest and don't depend on paper. Phase B is now *only* paper execution, which is the part that needs more design.

## 12. Non-goals (the line this stays behind)

- **No alpha/strategy layer.** This is measurement apparatus, not a money-maker.
- **No paper or live execution** in v1 — backtest only (`PaperBackend`/`LiveBackend` are designed-for stubs; paper has no execution path in the codebase today and is a Phase-B design pass).
- **No loosening of the LLM safety boundary** — JSON-only decisions, no tool/web access from agent responses.
- **No universe expansion** beyond DJIA-30 in v1 (the field is declared so it *can* expand later).
- **No MCP server build** in v1 (REST is shaped for it; Phase C).
- Plan 2 does **not** compute sentiment — it types the slot; Plan 1 owns the computation.
- **No durable cross-worker run state.** In-flight runs live in process memory (today's `_sessions` dict behind a `threading.Lock`); v2 inherits this and **assumes single-worker or sticky-routed deploys**. A run does not survive a process restart, and concurrent multi-worker deploys (e.g. scaled Render) would break run affinity. This is the first thing to revisit if Plan 3 runs many agents concurrently at scale; durable run state is out of scope for v1.

## 13. Backward compatibility

`/api/v1/*` and all legacy flat routes (`/runs`, `/paper/*`, `/health`, …) are untouched. The existing `external_agent_client.py` keeps working against v1. v2 is additive; the committed seed DB and `defaults.json` are unaffected (DB changes are additive + self-migrating).

# My Agents "Configure & run" rebuild — design

**Date:** 2026-07-22
**Status:** Approved (design reviewed in session; decisions 1, 2, 4 of the Two-Demo Plan resolved)
**Upstream:** ATL Two-Demo Plan (2026-07), Demo 1 — "Configure and run"
**Branch:** `feat/my-agents-configure-run`

## Goal

A first-time, non-technical user opens My Agents, sees a default agent in each
category row, presses **Configure**, sets money + one plain-language
instruction + a model, presses **Run Backtest**, and gets a result — with no
help. ATL's audience is people with money who want to trade, not tech geeks;
today's tab fails that test (flat grid, editor hidden behind ⋮ → Edit, editor
is a multi-step sub-agent pipeline, model frozen at creation, cash capped at
$3,000).

## Resolved decisions

1. **Simple Configure screen** (capital / instruction / model) is the default
   editor; today's multi-step pipeline moves behind an **Advanced** toggle.
2. **Default Foundation agent = DeepSeek V4 Pro** (`deepseek/deepseek-v4-pro`),
   the only leaderboard entry that beat the passive baselines. External row
   gets a reserved placeholder card (the real connection mechanism is an open
   teammate decision).
3. **Capital ceiling raised**: `MAX_AGENT_CASH_ALLOCATION` 3,000 → 1,000,000
   (default stays 1,000).

## Component 1 — Two category rows

*Files: `dashboard/frontend/app.html`, `dashboard/frontend/app.js`*

Replace the flat `#agentsGrid` (app.html ~:740) + type-filter dropdown
(~:718) with two labelled sections below the Capital Allocation charts:

- **Foundation Models** (`agent_type: 'builtin'`) — subtitle: *"A prompting
  game — give it money, an instruction, and a model, then backtest."*
- **External Agents** (`agent_type: 'external'`) — subtitle: *"Bring your own
  agent and connect it with an API key."*

`renderAgentCategories()` replaces `renderAgentsGrid()` (app.js ~:753):
partition decorated agents by `agent_type`, default agent pinned first in its
row. Search still filters both rows; Add Agent and the card/list view toggle
stay; the now-redundant type dropdown is removed. Empty-row states: Foundation
never renders empty for a signed-in user (see Component 2); External shows the
placeholder card.

## Component 2 — Default agent per user (client-driven)

*Files: `dashboard/frontend/app.js`*

- **Foundation:** when an authenticated user's agent list contains zero
  built-in agents, auto-provision one real agent via the existing
  `POST /api/v1/agents`: name **"My Foundation Agent"**, model
  `deepseek/deepseek-v4-pro`, cash 1,000, and a seeded one-step starter
  instruction (stored per Component 4's storage model) so it opens in Simple
  mode and runs immediately. Starter instruction text: *"Spread the money
  across a few of the strongest available stocks. Buy on meaningful dips,
  take profits after strong run-ups, and never put everything into one
  stock."* A localStorage guard
  (`default-agent-provisioned:<user>`) is set after the first provision so a
  user who deletes the agent doesn't get it re-created. Failure to provision
  (network/auth) is non-fatal: the row falls back to its empty state with a
  "Create agent" call-to-action.
- **Default badge & pointer:** the default agent carries a "Default" badge and
  is pinned first. The pointer is a **new** localStorage key
  (`default-agent-id:<user>`), deliberately distinct from the session-scoped
  `active-agent-id` (app.js :11): "default" is which agent greets you,
  "active" is which one you're working with right now. A "Set as default"
  card action repoints it. Durable per-account default is a flagged backend
  follow-up, out of scope.
- **External:** a reserved placeholder card ("Connect your own agent") — no
  real agent row is created. Its button opens the existing external-agent
  creation flow. This reserves the row and the Configure entry point without
  pre-deciding the key-flow direction.

## Component 3 — First-class Configure button

*Files: `dashboard/frontend/app.js`*

Every agent card gets a **Configure** button rendered above "Run Backtest"
(`renderAgentCardActions`, app.js ~:583). It opens the agent's editor
directly (Simple mode per Component 4's detection rule). The hidden
"⋮ → Edit" item is removed (Configure supersedes it); the ⋮ menu keeps
rotate-key / delete / set-as-default.

## Component 4 — Simple ⇄ Advanced Configure screen

*Files: `dashboard/frontend/js/agent-editor.js`, `app.html`, `styles.css`*

A mode toggle in the editor header (`#agentEditorView`, app.html ~:748).

**Simple (default)** — three fields:
- **Capital** — "How much should it trade?" (respects the new 1,000,000 cap).
- **Instruction** — one plain-language textarea.
- **Model** — dropdown, now **editable**, options cloned from the create
  modal's `#builtinAgentModel` list so the two never drift.

**Advanced** — today's multi-step pipeline UI, unchanged.

### Storage model — Simple is a one-step pipeline (no migration)

The instruction is stored as the agent's `pipeline` with exactly one step:

```json
[{
  "id": "sub_…",
  "presetKey": "simple_instruction",
  "label": "Trading instruction",
  "prompt": "<the user's plain-language instruction>",
  "outputFormat": "JSON: { \"orders\": [{ \"symbol\": \"...\", \"side\": \"buy|sell|hold\", \"qty\": number, \"order_type\": \"market|limit\", \"limit_price\": number|null, \"reason\": \"...\" }] }"
}]
```

The `outputFormat` is fixed and hidden in Simple mode — verbatim the proven
`signal_to_execution` preset contract (agent-editor.js :42-43), which
`pipeline_output_to_decision` (pipeline_runner.py :145) already normalizes
into `{"actions": [...]}`. The backend pipeline runner gives a single step
both the market snapshot and the execution rules (`_build_step_prompt`,
pipeline_runner.py :91-142), so one instruction + this contract is a
complete, working backtest driver. `presetKey: "simple_instruction"` is inert
on the backend (only `post_trade_analysis` is special-cased) and unknown keys
already fall back to the custom preset in the Advanced renderer.

### Mode detection & switching

- Open in **Simple** when the pipeline is empty or is exactly one
  `simple_instruction` step; otherwise open in **Advanced**.
- Advanced → Simple on a multi-step agent shows the instruction field empty
  with an explicit notice: *"Saving in Simple mode replaces the pipeline with
  one instruction."* Nothing is destroyed until the user saves.
- Simple → Advanced shows the one step in the pipeline UI (falls back to the
  custom preset renderer).

### Save path

Simple save calls the existing PATCH `/api/v1/agents/{id}` with
`{name, description, pipeline: <1 step>, cash_allocation, model_name}` —
`model_name` is the one new field (Component 5). Advanced save is unchanged
plus `model_name`.

## Component 5 — Backend (two changes; no migration, no new route)

1. **`model_name` becomes PATCH-editable.** The `external_agents.model_name`
   column already exists (repository.py :100). Add the optional field through
   the chain, following the `_UNSET` sentinel pattern already used there:
   - `UpdateAgentBody` (api/routers/agents.py :58-66) — validate against
     non-empty string, max length matching the create path;
   - `AgentService.update_agent` (domain/agents/service.py :179-197);
   - `update_agent` in both repos: SQLite (domain/agents/repository.py
     :457-505) and the Postgres twin (repository_postgres.py :414-456).
   No route is added, so the three route-contract freeze tests stay green.
2. **Cash cap:** `MAX_AGENT_CASH_ALLOCATION` 3,000 → 1,000,000 in
   `domain/backtesting/constants.py` (:24-31). `resolve_initial_capital`
   and the create/patch validators pick the constant up. Frontend: the two
   hardcoded `max="3000"` inputs (app.html ~:609 create modal, ~:760 editor)
   and their "(max $3,000)" labels, plus the editor's JS clamp
   (agent-editor.js `getEditorState` :170-193) move to 1,000,000.

## Data flow (end-to-end)

Configure (Simple) → PATCH persists `pipeline` (1 step) + `model_name` +
`cash_allocation` → Run Backtest (`runBacktest`, app.js ~:3180) already sends
`model: agent.model_name` and `pipeline: loadAgentPipelineForBacktest(agent)`
to `POST /backtest/run` → engine runs the pipeline path
(`make_trading_decision_with_llm` precedence: pipeline first,
portfolio_manager.py :290-366) → decision → result. No new wiring needed at
run time.

## Error handling

- Pipeline step parse failure at run time already degrades to
  `{"actions": []}` (hold) — unchanged, acceptable.
- PATCH `model_name` rejects empty/oversized strings with 422 (Pydantic).
- Default-agent provisioning failure is silent-but-visible: empty-row CTA
  instead of a broken card; no retry loop.
- Cash validation stays server-side authoritative (0..1,000,000), client
  clamps mirror it.

## Testing & verification

- **Backend (pytest):** PATCH `model_name` round-trip (SQLite; Postgres twin
  covered by the existing `@pg_only` pattern where applicable), `model_name`
  absent-vs-null semantics under `_UNSET`, cap boundary cases (1,000,000
  accepted, above rejected), full suite + the three route-freeze guards.
- **Frontend (manual, no build step):** run `uvicorn dashboard.backend.app:app`
  and click the exit-criterion path end-to-end: open My Agents → default agent
  visible in each row → Configure → set money + instruction + model → Run
  Backtest → result renders. Also: mode detection on a multi-step agent,
  Simplify-replaces-pipeline warning, search across both rows.

## Out of scope

Advanced pipeline internals (kept, not deleted) · paper trading · the real
External-Agent connection mechanism (open teammate decision) · durable
per-account default (client-side for the demo; backend follow-up flagged).

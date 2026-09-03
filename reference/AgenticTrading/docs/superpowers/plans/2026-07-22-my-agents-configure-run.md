# My Agents "Configure & run" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Update (2026-07-23, PR #181):** the $1,000,000 cap this plan introduced was
> lowered back to **$3,000** once the account-bound $10k cash ledger (#174/#175)
> became real — a sleeve larger than the account can no longer be funded. Cap
> references below reflect the plan as executed on 2026-07-22, not current code.

**Goal:** Rebuild the My Agents tab so a first-time non-technical user sees a default agent in two category rows, presses Configure, sets capital + one plain-language instruction + a model, and runs a backtest unaided.

**Architecture:** Frontend-heavy (vanilla JS, no build step). Simple mode is a *data convention*: a one-step `pipeline` with `presetKey: "simple_instruction"` and a fixed trading-actions `outputFormat` — it reuses the existing PATCH save path and the existing backtest pipeline path end-to-end. The only backend deltas are making `model_name` PATCH-editable (column already exists) and raising the cash cap constant. No new routes, no DB migration.

**Tech Stack:** FastAPI + Pydantic (backend), vanilla JS + Chart.js (frontend, no build), pytest.

**Spec:** `docs/superpowers/specs/2026-07-22-my-agents-configure-run-design.md`

## Global Constraints

- Run everything from the **repo root** (`/mnt/d/github/agent-trading-lab`). The backend is the `dashboard.backend` package — never run files directly.
- Test runner: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/... -v` (pytest is not in requirements.txt; the venv has it).
- **No new API routes** — three route-contract freeze tests turn CI red on any added route. Adding a *field* to an existing request body is safe.
- **No DB migration** — `external_agents.model_name` already exists (`repository.py:100`, `NOT NULL DEFAULT 'local-model'`).
- Default Foundation model value: exactly `deepseek/deepseek-v4-pro` (must match the create-modal option, `app.html:599`).
- Simple-mode preset key: exactly `simple_instruction`. It is inert on the backend (only `post_trade_analysis` is special-cased) and unknown keys fall back to the custom preset in the Advanced renderer.
- Simple-mode fixed output contract (single source of drift-risk — copy this exact string everywhere it appears):
  `JSON: { "orders": [{ "symbol": "...", "side": "buy|sell|hold", "qty": number, "order_type": "market|limit", "limit_price": number|null, "reason": "..." }] }`
  (verbatim the `signal_to_execution` preset contract, `agent-editor.js:43`, which `pipeline_output_to_decision` already normalizes into `{"actions": [...]}`).
- Starter instruction text (exact): `Spread the money across a few of the strongest available stocks. Buy on meaningful dips, take profits after strong run-ups, and never put everything into one stock.`
- Cash cap: `MAX_AGENT_CASH_ALLOCATION` = **1_000_000** everywhere (backend constant + 3 HTML inputs + 2 JS clamps). Default stays 1000.
- localStorage keys: default pointer `default-agent-id:<BROWSER_OWNER_ID>`, provision guard `default-agent-provisioned:<BROWSER_OWNER_ID>`.
- Frontend has no JS test framework — frontend tasks are verified by serving the app (`~/atl-venv/bin/python -m uvicorn dashboard.backend.app:app`) and clicking the listed checks. Backend tasks are TDD.

---

### Task 1: Backend — raise the cash cap to $1,000,000

**Files:**
- Modify: `dashboard/backend/domain/backtesting/constants.py:14,31`
- Test: `dashboard/backend/tests/test_agents_api.py` (append)

**Interfaces:**
- Produces: `MAX_AGENT_CASH_ALLOCATION == 1_000_000` — consumed by `api/routers/agents.py` validators and `resolve_initial_capital` clamping (both import the constant; no other edits needed).

- [ ] **Step 1: Write the failing test** — append to `dashboard/backend/tests/test_agents_api.py`:

```python
def test_cash_allocation_cap_is_one_million(client):
    """Demo 1: the per-agent cap was raised 3,000 -> 1,000,000."""
    from dashboard.backend.domain.backtesting.constants import (
        MAX_AGENT_CASH_ALLOCATION,
        resolve_initial_capital,
    )

    assert MAX_AGENT_CASH_ALLOCATION == 1_000_000
    # Clamp behavior follows the constant.
    assert resolve_initial_capital(1_000_000) == 1_000_000.0
    assert resolve_initial_capital(2_000_000) == 1_000_000.0

    browser_session = str(uuid.uuid4())
    headers = {"X-Session-Id": browser_session, "X-Browser-Id": browser_session}

    ok = client.post(
        "/api/v1/agents",
        json={
            "name": "Whale",
            "agent_type": "builtin",
            "cash_allocation": 1_000_000,
        },
        headers=headers,
    )
    assert ok.status_code == 200
    assert ok.json()["agent"]["cash_allocation"] == 1_000_000

    too_big = client.post(
        "/api/v1/agents",
        json={"name": "Too big", "agent_type": "builtin", "cash_allocation": 1_000_001},
        headers=headers,
    )
    assert too_big.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_agents_api.py::test_cash_allocation_cap_is_one_million -v`
Expected: FAIL on `assert MAX_AGENT_CASH_ALLOCATION == 1_000_000` (it is 3000).

- [ ] **Step 3: Raise the constant** — in `dashboard/backend/domain/backtesting/constants.py` change line 31:

```python
MAX_AGENT_CASH_ALLOCATION = 1_000_000
```

and update the docstring line 13-14 to read:

```
- Per-agent starting cash: default ``DEFAULT_AGENT_CASH_ALLOCATION`` ($1,000),
  max ``MAX_AGENT_CASH_ALLOCATION`` ($1,000,000)
```

- [ ] **Step 4: Run the test and the full backend suite**

Run: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/ -q`
Expected: all green (no existing test pins the 3000 cap — verified by grep before this plan was written; a failure here means a real interaction, stop and read it).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/domain/backtesting/constants.py dashboard/backend/tests/test_agents_api.py
git commit -m "feat: raise per-agent cash cap to \$1,000,000"
```

---

### Task 2: Backend — make `model_name` PATCH-editable

**Files:**
- Modify: `dashboard/backend/api/routers/agents.py:58-66` (UpdateAgentBody), `:233-270` (PATCH handler)
- Modify: `dashboard/backend/domain/agents/service.py:179-197`
- Modify: `dashboard/backend/domain/agents/repository.py:457-505`
- Modify: `dashboard/backend/domain/agents/repository_postgres.py:414-456`
- Test: `dashboard/backend/tests/test_agents_api.py`, `dashboard/backend/tests/test_agent_store_postgres.py`

**Interfaces:**
- Produces: `PATCH /api/v1/agents/{agent_id}` accepts optional `model_name: str` (1..100 chars); omitted/null → unchanged. `AgentStore.update_agent(..., model_name: Optional[str] = None)` in both stores. Task 7's frontend sends this field.

- [ ] **Step 1: Write the failing API test** — append to `dashboard/backend/tests/test_agents_api.py`:

```python
def test_patch_agent_model_name(client):
    """Demo 1: the Configure screen can change the model after creation."""
    browser_session = str(uuid.uuid4())
    headers = {"X-Session-Id": browser_session, "X-Browser-Id": browser_session}

    created = client.post(
        "/api/v1/agents",
        json={
            "name": "Model Swapper",
            "model_name": "anthropic/claude-haiku-4-5",
            "agent_type": "builtin",
        },
        headers=headers,
    )
    assert created.status_code == 200
    agent_id = created.json()["agent"]["agent_id"]

    patched = client.patch(
        f"/api/v1/agents/{agent_id}",
        json={"model_name": "deepseek/deepseek-v4-pro"},
        headers=headers,
    )
    assert patched.status_code == 200
    assert patched.json()["agent"]["model_name"] == "deepseek/deepseek-v4-pro"

    # Absent field leaves the model untouched.
    renamed = client.patch(
        f"/api/v1/agents/{agent_id}",
        json={"name": "Still Swapped"},
        headers=headers,
    )
    assert renamed.status_code == 200
    assert renamed.json()["agent"]["model_name"] == "deepseek/deepseek-v4-pro"

    # Empty string is rejected by validation.
    empty = client.patch(
        f"/api/v1/agents/{agent_id}",
        json={"model_name": ""},
        headers=headers,
    )
    assert empty.status_code == 422

    # model_name alone is a valid update (not "No fields to update").
    only_model = client.patch(
        f"/api/v1/agents/{agent_id}",
        json={"model_name": "openai/gpt-5.5"},
        headers=headers,
    )
    assert only_model.status_code == 200
    assert only_model.json()["agent"]["model_name"] == "openai/gpt-5.5"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_agents_api.py::test_patch_agent_model_name -v`
Expected: FAIL — first PATCH returns 400 "No fields to update" (model_name is silently ignored by the current body model).

- [ ] **Step 3: Add the field through the chain.**

In `dashboard/backend/api/routers/agents.py`, `UpdateAgentBody` becomes:

```python
class UpdateAgentBody(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    model_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, max_length=280)
    pipeline: Optional[List[PipelineStep]] = Field(default=None, max_length=50)
    cash_allocation: Optional[float] = Field(
        default=None,
        ge=0,
        le=MAX_AGENT_CASH_ALLOCATION,
    )
```

In the PATCH handler (`update_agent`, `:233-270`), change the no-op guard and the service call (keep everything else identical):

```python
    if (
        body.name is None
        and body.model_name is None
        and body.description is None
        and not pipeline_provided
        and not cash_allocation_provided
    ):
        raise HTTPException(status_code=400, detail="No fields to update")
```

```python
        agent = agent_service.update_agent(
            agent_id,
            name=body.name.strip() if body.name is not None else None,
            model_name=body.model_name.strip() if body.model_name is not None else None,
            description=body.description,
            pipeline=pipeline_arg,
            cash_allocation=cash_allocation_arg,
        )
```

In `dashboard/backend/domain/agents/service.py`, `AgentService.update_agent` becomes:

```python
    def update_agent(
        self,
        agent_id: str,
        *,
        name: Optional[str] = None,
        model_name: Optional[str] = None,
        description: Optional[str] = None,
        pipeline: Any = _UNSET,
        cash_allocation: Any = _UNSET,
    ) -> Dict[str, Any]:
        agent = self.agents.update_agent(
            agent_id,
            name=name,
            model_name=model_name,
            description=description,
            pipeline=pipeline,
            cash_allocation=cash_allocation,
        )
        if not agent:
            raise AgentNotFoundError()
        return self.agent_with_stats(agent)
```

In `dashboard/backend/domain/agents/repository.py`, `update_agent` signature gains `model_name: Optional[str] = None` (after `name`), and after the `if name is not None:` block add:

```python
        if model_name is not None:
            sets.append("model_name = ?")
            params.append(model_name.strip())
```

In `dashboard/backend/domain/agents/repository_postgres.py`, identical change with `%s`:

```python
        if model_name is not None:
            sets.append("model_name = %s")
            params.append(model_name.strip())
```

(Both repos: `model_name=None` means "leave unchanged" — same convention as `name`; the column is NOT NULL so there is deliberately no "clear it" path.)

- [ ] **Step 4: Run the API test**

Run: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_agents_api.py::test_patch_agent_model_name -v`
Expected: PASS

- [ ] **Step 5: Add the Postgres-parity test** — append to `dashboard/backend/tests/test_agent_store_postgres.py` (follow the existing `@pg_only` + `pg_agent_store` fixture pattern used by `test_update_agent_partial_updates_postgres`):

```python
@pg_only
def test_update_agent_model_name_postgres(pg_agent_store):
    created = pg_agent_store.create_agent(
        name="Model Swap PG",
        model_name="anthropic/claude-haiku-4-5",
        owner_user_id=None,
        owner_browser_session="pg-model-swap",
    )
    updated = pg_agent_store.update_agent(
        created["agent_id"], model_name="deepseek/deepseek-v4-pro"
    )
    assert updated["model_name"] == "deepseek/deepseek-v4-pro"

    # Omitting model_name leaves it unchanged.
    renamed = pg_agent_store.update_agent(created["agent_id"], name="Renamed")
    assert renamed["model_name"] == "deepseek/deepseek-v4-pro"
```

NOTE: `@pg_only` skips (fails OPEN) without `TEST_POSTGRES_URL`; green CI does not prove this ran. Run it locally only against a **localhost** Postgres if available — never point `TEST_POSTGRES_URL` at a remote/prod URL. If no local PG, the skip is acceptable: the SQL delta is four lines and mirrors the SQLite twin verbatim.

- [ ] **Step 6: Run the full backend suite**

Run: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/ -q`
Expected: all green (PG test skips without TEST_POSTGRES_URL).

- [ ] **Step 7: Commit**

```bash
git add dashboard/backend/api/routers/agents.py dashboard/backend/domain/agents/service.py \
  dashboard/backend/domain/agents/repository.py dashboard/backend/domain/agents/repository_postgres.py \
  dashboard/backend/tests/test_agents_api.py dashboard/backend/tests/test_agent_store_postgres.py
git commit -m "feat: allow PATCH to update agent model_name"
```

---

### Task 3: Frontend — mirror the new cash cap

**Files:**
- Modify: `dashboard/frontend/app.js:132`
- Modify: `dashboard/frontend/app.html:571-572,608-609,759-760`
- Modify: `dashboard/frontend/js/agent-editor.js:180-181`

**Interfaces:**
- Consumes: Task 1's backend cap (client caps must never exceed the server's).
- Produces: all three cash inputs accept up to 1,000,000.

- [ ] **Step 1: app.js constant** — line 132 becomes:

```js
const MAX_AGENT_CASH_ALLOCATION = 1000000;
```

(`parseAgentCashAllocationInput` already builds its error strings from the constant via `toLocaleString()` — no other app.js change.)

- [ ] **Step 2: app.html — all three cash inputs.** Replace the label text and `max` attribute in each of these pairs (external modal :571-572, builtin modal :608-609, editor header :759-760):

```html
<span>Initial cash (max $1,000,000)</span>
<input id="externalAgentCashAllocation" type="number" min="0" max="1000000" step="1" value="1000" required aria-describedby="externalAgentCashHint">
```

```html
<span>Initial cash (max $1,000,000)</span>
<input id="builtinAgentCashAllocation" type="number" min="0" max="1000000" step="1" value="1000" required aria-describedby="builtinAgentCashHint">
```

```html
<span class="agent-editor-cash-label">Initial cash (max $1,000,000)</span>
<input id="agentEditorCashAllocation" class="agent-editor-cash-input" type="number" min="0" max="1000000" step="1" placeholder="0" aria-label="Initial cash">
```

- [ ] **Step 3: agent-editor.js clamp** — in `getEditorState` (:180-181) replace:

```js
      if (value > 1000000) {
        throw new Error('Initial cash cannot exceed $1,000,000.');
      }
```

- [ ] **Step 4: Verify by grep (no build step, so drift is the failure mode)**

Run: `grep -rn "3,000\|max=\"3000\"\|> 3000" dashboard/frontend/`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add dashboard/frontend/app.js dashboard/frontend/app.html dashboard/frontend/js/agent-editor.js
git commit -m "feat: raise frontend cash caps to \$1,000,000"
```

---

### Task 4: Frontend — two category rows (Foundation Models / External Agents)

**Files:**
- Modify: `dashboard/frontend/app.html:717-724,740-742` (toolbar + grid)
- Modify: `dashboard/frontend/app.js:632-657` (applyAgentFilters), `:659-665` (setAgentViewMode), `:707-714` (renderAgentsError), `:753-870` (renderAgentsGrid → renderAgentCards + renderAgentCategories), `:872-880` (document click closer), `:3789` (filter binding)
- Modify: `dashboard/frontend/styles.css` (append)

**Interfaces:**
- Consumes: `agent_type` on each agent (`'builtin'` vs anything else), existing `decorateAgent`, `bindAgentCardMenus`, card renderers.
- Produces: `renderAgentCategories(agents)` (called by `applyAgentFilters`), `renderAgentCards(grid, agents)`, `renderExternalPlaceholderCard(grid)`, `getDefaultAgentId()` / `setDefaultAgentId(id)` / `defaultAgentKey()` (used by Tasks 5-6), grid ids `agentsGridBuiltin` / `agentsGridExternal`.

- [ ] **Step 1: app.html — remove the type-filter dropdown.** Delete lines 718-724 (the whole `<select id="agentFilterSelect">…</select>`), keeping the search box, view toggle, and Add Agent button.

- [ ] **Step 2: app.html — replace the flat grid (lines 740-742) with two category sections:**

```html
                <div id="agentsCategories">
                    <section class="agents-category" data-category="builtin">
                        <div class="agents-category-head">
                            <h3 class="agents-category-title">Foundation Models</h3>
                            <p class="agents-category-sub">A prompting game — give it money, an instruction, and a model, then backtest.</p>
                        </div>
                        <div id="agentsGridBuiltin" class="agents-grid"></div>
                        <p id="agentsEmptyBuiltin" class="control-helper" hidden>No foundation agents yet. Click <strong>Add Agent</strong> to create one.</p>
                    </section>
                    <section class="agents-category" data-category="external">
                        <div class="agents-category-head">
                            <h3 class="agents-category-title">External Agents</h3>
                            <p class="agents-category-sub">Bring your own agent and connect it with an API key.</p>
                        </div>
                        <div id="agentsGridExternal" class="agents-grid"></div>
                    </section>
                </div>
                <p id="agentsErrorState" class="control-helper" hidden style="color:#f87171;">Couldn't reach the server to load agents. Check your connection and try again.</p>
```

(The old `agentsGrid` and `agentsEmptyState` ids disappear; the external row's empty state is the placeholder card rendered by JS.)

- [ ] **Step 3: app.js — default-pointer helpers.** Insert after the `AGENT_CASH_OVERRIDE_PREFIX` constant (line ~135):

```js
const DEFAULT_AGENT_KEY_PREFIX = 'default-agent-id:';

function defaultAgentKey() {
  return `${DEFAULT_AGENT_KEY_PREFIX}${window.BROWSER_OWNER_ID || 'anon'}`;
}

function getDefaultAgentId() {
  try {
    return localStorage.getItem(defaultAgentKey());
  } catch (e) {
    return null;
  }
}

function setDefaultAgentId(agentId) {
  try {
    localStorage.setItem(defaultAgentKey(), agentId);
  } catch (e) {
    /* storage unavailable — badge simply won't persist */
  }
}
```

- [ ] **Step 4: app.js — simplify `applyAgentFilters` (:632-657).** The type filter is gone; search stays and filters both rows:

```js
function applyAgentFilters() {
  const query = (document.getElementById('agentSearchInput')?.value || '').trim().toLowerCase();

  let list = allAgents.map(decorateAgent);
  if (query) {
    list = list.filter(
      (a) =>
        String(a.name || '').toLowerCase().includes(query) ||
        String(a.model_name || '').toLowerCase().includes(query),
    );
  }

  renderAgentCategories(list);
}
```

- [ ] **Step 5: app.js — split `renderAgentsGrid` (:753-870) into `renderAgentCards(grid, agents)` + `renderAgentCategories(agents)`.** `renderAgentCards` is the old body parameterized by `grid`, minus the empty/error handling (which moves to the category level):

```js
function renderAgentCards(grid, agents) {
  grid.innerHTML = '';

  agents.forEach((agent) => {
    const isBuiltin = agent.agent_type === 'builtin';
    const statusBadge = resolveAgentStatusBadge(agent);
    const card = document.createElement('div');
    card.className = `section-card agent-card agent-card--status agent-card--${statusBadge.key}${isBuiltin ? ' agent-card-builtin' : ''}`;
    const model = escapeHtml(agent.model_name || 'local-model');
    const type = escapeHtml(agentTypeLabel(agent));

    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-card-identity">
          ${agentRobotIcon()}
          <div class="agent-card-identity-text">
            <h3 class="agent-name">${escapeHtml(agent.name)}</h3>
            <p class="agent-card-submeta">${model} · ${type}</p>
          </div>
        </div>
        <span class="status-badge ${statusBadge.className}"><span class="status-badge-dot" aria-hidden="true"></span>${statusBadge.label}</span>
      </div>
      ${renderAgentCardBody(agent, statusBadge.key)}
      ${renderAgentCardActions(agent, statusBadge.key)}
    `;
    grid.appendChild(card);
  });

  bindAgentCardMenus(grid);
  // …every existing grid.querySelectorAll(...) binding block from the old
  // renderAgentsGrid (:794-869) stays here VERBATIM: .agent-edit-btn,
  // .agent-open-btn, .agent-view-runs-btn, .agent-run-backtest-btn,
  // .agent-rotate-key-btn, .agent-delete-btn. They already operate on the
  // `grid` element and the `agents` argument, so they work unchanged.
}
```

Then add the category renderer and the placeholder card:

```js
function renderAgentCategories(agents) {
  const builtinGrid = document.getElementById('agentsGridBuiltin');
  const externalGrid = document.getElementById('agentsGridExternal');
  const errorEl = document.getElementById('agentsErrorState');
  if (!builtinGrid || !externalGrid) return;

  if (errorEl) errorEl.hidden = true; // a successful render clears any prior error

  const defaultId = getDefaultAgentId();
  const pinDefaultFirst = (list) =>
    [...list].sort((a, b) => (b.agent_id === defaultId) - (a.agent_id === defaultId));

  const builtin = pinDefaultFirst(agents.filter((a) => a.agent_type === 'builtin'));
  const external = pinDefaultFirst(agents.filter((a) => a.agent_type !== 'builtin'));

  renderAgentCards(builtinGrid, builtin);
  renderAgentCards(externalGrid, external);

  const builtinEmpty = document.getElementById('agentsEmptyBuiltin');
  if (builtinEmpty) builtinEmpty.hidden = builtin.length > 0;
  if (!external.length) renderExternalPlaceholderCard(externalGrid);
}

// Reserved entry point for connect-your-own agents: the connection mechanism
// is still an open team decision, so this opens the existing creation flow.
function renderExternalPlaceholderCard(grid) {
  const card = document.createElement('div');
  card.className = 'section-card agent-card agent-card--placeholder';
  card.innerHTML = `
    <div class="agent-card-identity-text">
      <h3 class="agent-name">Connect your own agent</h3>
      <p class="agent-card-submeta">Run your own trading agent against our backtests via an API key.</p>
    </div>
    <button class="agent-card-cta agent-card-cta--outline" type="button">Connect agent</button>`;
  card.querySelector('button')?.addEventListener('click', openCreateExternalAgentModal);
  grid.appendChild(card);
}
```

- [ ] **Step 6: app.js — fix the three references to the old single grid.**

`setAgentViewMode` (:659-665):

```js
function setAgentViewMode(mode) {
  agentViewMode = mode === 'list' ? 'list' : 'grid';
  document.querySelectorAll('.agents-section .agents-grid').forEach((grid) => {
    grid.classList.toggle('agents-grid--list', agentViewMode === 'list');
  });
  document.getElementById('agentViewGrid')?.classList.toggle('active', agentViewMode === 'grid');
  document.getElementById('agentViewList')?.classList.toggle('active', agentViewMode === 'list');
}
```

`renderAgentsError` (:707-714):

```js
function renderAgentsError() {
  const errorEl = document.getElementById('agentsErrorState');
  document.querySelectorAll('.agents-section .agents-grid').forEach((grid) => {
    grid.innerHTML = '';
  });
  const builtinEmpty = document.getElementById('agentsEmptyBuiltin');
  if (builtinEmpty) builtinEmpty.hidden = true;
  if (errorEl) errorEl.hidden = false;
}
```

Document click-closer (:872-880) — change both selectors from `#agentsGrid …` to `.agents-grid …`:

```js
document.addEventListener('click', (event) => {
  if (event.target.closest?.('.agent-card-menu')) return;
  document.querySelectorAll('.agents-grid .agent-menu-dropdown').forEach((el) => {
    el.hidden = true;
  });
  document.querySelectorAll('.agents-grid .agent-menu-toggle').forEach((el) => {
    el.setAttribute('aria-expanded', 'false');
  });
});
```

- [ ] **Step 7: app.js — remove the dead filter binding.** Delete line 3789 (`document.getElementById('agentFilterSelect')?.addEventListener('change', applyAgentFilters);`).

- [ ] **Step 8: styles.css — append category + placeholder styles** (dark theme, existing var names):

```css
/* My Agents — category rows (Demo 1) */
.agents-category { margin-top: 28px; }
.agents-category:first-child { margin-top: 8px; }
.agents-category-head { margin-bottom: 14px; }
.agents-category-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 2px;
}
.agents-category-sub {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin: 0;
}
.agent-card--placeholder {
    border-style: dashed;
    display: flex;
    flex-direction: column;
    gap: 14px;
    justify-content: center;
    align-items: flex-start;
}
```

- [ ] **Step 9: Verify by serving the app.**

Run: `~/atl-venv/bin/python -m uvicorn dashboard.backend.app:app` then open `http://localhost:8000/app`, go to My Agents.
Checks: two labelled rows render below the allocation charts; builtin agents in the top row, external below; the External row shows the "Connect your own agent" dashed card when no external agents exist and its button opens the external-agent modal; search filters both rows; grid/list toggle affects both rows; the type dropdown is gone; card ⋮ menus open and close.

- [ ] **Step 10: Commit**

```bash
git add dashboard/frontend/app.html dashboard/frontend/app.js dashboard/frontend/styles.css
git commit -m "feat: group My Agents into Foundation Models and External Agents rows"
```

---

### Task 5: Frontend — Configure button, Default badge, Set as default

**Files:**
- Modify: `dashboard/frontend/app.js` — `renderAgentCardActions` (:583-611), card markup + bindings inside `renderAgentCards` (from Task 4)
- Modify: `dashboard/frontend/styles.css` (append)

**Interfaces:**
- Consumes: `getDefaultAgentId()` / `setDefaultAgentId()` (Task 4), `window.AgentEditor.open(agent)`.
- Produces: `.agent-configure-btn` (primary entry to the editor — replaces the ⋮ Edit item), `.agent-set-default-btn` menu item, `.agent-default-badge` on the default agent's card.

- [ ] **Step 1: `renderAgentCardActions` — add Configure above the primary CTA, swap Edit for Set as default:**

```js
function renderAgentCardActions(agent, statusKey) {
  const id = escapeHtml(agent.agent_id);
  let primary = '';
  if (statusKey === 'paper') {
    primary = `<button class="agent-card-cta agent-open-btn" type="button" data-agent-id="${id}">Open Agent</button>`;
  } else if (statusKey === 'backtested') {
    primary = `<button class="agent-card-cta agent-card-cta--outline agent-view-runs-btn" type="button" data-agent-id="${id}">View All Runs</button>`;
  } else {
    primary = `<button class="agent-card-cta agent-run-backtest-btn" type="button" data-agent-id="${id}">Run Backtest</button>`;
  }
  const configure = `<button class="agent-card-cta agent-card-cta--configure agent-configure-btn" type="button" data-agent-id="${id}">Configure</button>`;
  const rotate =
    agent.agent_type === 'builtin'
      ? ''
      : `<button class="agent-menu-item agent-rotate-key-btn" type="button" data-agent-id="${id}">New API key</button>`;
  return `
    <div class="agent-card-actions agent-card-actions--status">
      ${configure}
      ${primary}
      <div class="agent-card-menu">
        <button class="agent-menu-toggle" type="button" aria-label="More actions" aria-expanded="false" data-agent-id="${id}">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>
        </button>
        <div class="agent-menu-dropdown" hidden>
          <button class="agent-menu-item agent-set-default-btn" type="button" data-agent-id="${id}">Set as default</button>
          ${rotate}
          <button class="agent-menu-item agent-menu-item--danger agent-delete-btn" type="button" data-agent-id="${id}">Delete</button>
        </div>
      </div>
    </div>`;
}
```

- [ ] **Step 2: Default badge in the card markup.** In `renderAgentCards` (Task 4), compute the default id once per call (add `const defaultId = getDefaultAgentId();` before the `agents.forEach`), then change the name line to:

```js
            <h3 class="agent-name">${escapeHtml(agent.name)}${agent.agent_id === defaultId ? ' <span class="agent-default-badge">Default</span>' : ''}</h3>
```

- [ ] **Step 3: Bindings.** In `renderAgentCards`, replace the old `.agent-edit-btn` binding block with `.agent-configure-btn` (same handler body), and add `.agent-set-default-btn`:

```js
  grid.querySelectorAll('.agent-configure-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const agent = agents.find((a) => a.agent_id === btn.dataset.agentId);
      if (!agent || !window.AgentEditor) return;
      navigateToPage('playground', { playgroundTab: 'agents' });
      showPlaygroundPanel('agents');
      window.AgentEditor.open(agent);
    });
  });

  grid.querySelectorAll('.agent-set-default-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setDefaultAgentId(btn.dataset.agentId);
      applyAgentFilters(); // re-render: badge + pin move to the new default
    });
  });
```

- [ ] **Step 4: styles.css — append:**

```css
/* Configure CTA + Default badge (Demo 1) */
.agent-card-cta--configure {
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-primary);
}
.agent-card-cta--configure:hover { border-color: var(--text-secondary); }
.agent-default-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 600;
    vertical-align: middle;
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.45);
    background: rgba(16, 185, 129, 0.12);
}
```

- [ ] **Step 5: Verify by serving the app.**

Checks: every card shows Configure above the old primary button; Configure opens the fullscreen editor for that agent; ⋮ menu shows Set as default / (New API key for external) / Delete — no Edit; Set as default moves the badge and pins that card first in its row after re-render.

- [ ] **Step 6: Commit**

```bash
git add dashboard/frontend/app.js dashboard/frontend/styles.css
git commit -m "feat: first-class Configure button and per-user default agent badge"
```

---

### Task 6: Frontend — auto-provision the default Foundation agent

**Files:**
- Modify: `dashboard/frontend/app.js` — new constants near line ~135, new `ensureDefaultFoundationAgent()`, wire into `loadAgents` (:983-1049)

**Interfaces:**
- Consumes: `API.post` / `API.get` / `API.patch` (:1377-1438), `getDefaultAgentId`/`setDefaultAgentId` (Task 4), `isDemoMode()` (:696).
- Produces: on first visit with zero builtin agents, one real "My Foundation Agent" (DeepSeek V4 Pro) with a seeded 1-step `simple_instruction` pipeline; guard key prevents re-provision after deletion. Task 7 reads the same `SIMPLE_INSTRUCTION_*` constants (they live in agent-editor.js too — the two copies must stay byte-identical; see Global Constraints).

- [ ] **Step 1: Constants** — insert after the `DEFAULT_AGENT_KEY_PREFIX` block from Task 4:

```js
const DEFAULT_AGENT_PROVISION_GUARD_PREFIX = 'default-agent-provisioned:';
const DEFAULT_FOUNDATION_MODEL = 'deepseek/deepseek-v4-pro';
const SIMPLE_INSTRUCTION_PRESET_KEY = 'simple_instruction';
const SIMPLE_INSTRUCTION_OUTPUT_FORMAT =
  'JSON: { "orders": [{ "symbol": "...", "side": "buy|sell|hold", "qty": number, "order_type": "market|limit", "limit_price": number|null, "reason": "..." }] }';
const DEFAULT_STARTER_INSTRUCTION =
  'Spread the money across a few of the strongest available stocks. Buy on meaningful dips, take profits after strong run-ups, and never put everything into one stock.';
```

- [ ] **Step 2: Provisioning function** — add above `loadAgents`:

```js
// First-visit onboarding: a brand-new owner gets one real Foundation agent so
// the row is never empty. The guard key means "we provisioned once for this
// browser identity" — deleting the agent must NOT resurrect it.
let defaultAgentProvisionInFlight = false;

async function ensureDefaultFoundationAgent(agents) {
  if (isDemoMode()) return false;
  if (agents.some((a) => a.agent_type === 'builtin')) return false;
  const guardKey = `${DEFAULT_AGENT_PROVISION_GUARD_PREFIX}${window.BROWSER_OWNER_ID || 'anon'}`;
  try {
    if (localStorage.getItem(guardKey)) return false;
  } catch (e) {
    return false; // no storage → cannot guard → do not provision
  }
  if (defaultAgentProvisionInFlight) return false;
  defaultAgentProvisionInFlight = true;
  try {
    const data = await API.post(`${API_BASE}/api/v1/agents`, {
      name: 'My Foundation Agent',
      model_name: DEFAULT_FOUNDATION_MODEL,
      agent_type: 'builtin',
      description: 'Your starter agent — configure it and run a backtest.',
      cash_allocation: DEFAULT_AGENT_CASH_ALLOCATION,
    });
    const agent = data?.agent;
    if (!agent?.agent_id) return false;
    localStorage.setItem(guardKey, agent.agent_id);
    try {
      await API.patch(`${API_BASE}/api/v1/agents/${encodeURIComponent(agent.agent_id)}`, {
        pipeline: [
          {
            id: `sub_starter_${agent.agent_id}`,
            presetKey: SIMPLE_INSTRUCTION_PRESET_KEY,
            label: 'Trading instruction',
            prompt: DEFAULT_STARTER_INSTRUCTION,
            outputFormat: SIMPLE_INSTRUCTION_OUTPUT_FORMAT,
          },
        ],
      });
    } catch (seedError) {
      // Non-fatal: the agent exists; the editor just opens with a blank instruction.
      console.warn('Starter instruction seed failed:', seedError.message);
    }
    if (!getDefaultAgentId()) setDefaultAgentId(agent.agent_id);
    return true;
  } catch (error) {
    // Non-fatal: the row falls back to its empty state with the Add Agent CTA.
    console.warn('Default agent provisioning skipped:', error.message);
    return false;
  } finally {
    defaultAgentProvisionInFlight = false;
  }
}
```

- [ ] **Step 3: Wire into `loadAgents`.** Immediately after the demo-mode seeding block (`if (!agents.length && isDemoMode()) { … }`, :1020-1022) and before `allAgents = agents;`, insert:

```js
    if (await ensureDefaultFoundationAgent(agents)) {
      try {
        const refreshed = await API.get(`${API_BASE}/api/v1/agents`);
        agents = refreshed.agents || agents;
      } catch (refreshError) {
        console.warn('Refresh after default-agent provisioning failed:', refreshError.message);
      }
    }
```

- [ ] **Step 4: Verify by serving the app.**

In a fresh browser profile (or after `localStorage.clear()` in devtools): open `/app` → My Agents shows "My Foundation Agent" (DeepSeek V4 Pro, $1,000, Default badge) in the Foundation row. Delete it → row shows the empty-state CTA and the agent does NOT come back on reload (guard). In devtools, `localStorage` has `default-agent-provisioned:<uuid>` and `default-agent-id:<uuid>`. With `?demo=1`, no provisioning happens.

- [ ] **Step 5: Commit**

```bash
git add dashboard/frontend/app.js
git commit -m "feat: auto-provision a default Foundation agent on first visit"
```

---

### Task 7: Frontend — Simple ⇄ Advanced Configure screen + editable model

**Files:**
- Modify: `dashboard/frontend/app.html:748-807` (editor view)
- Modify: `dashboard/frontend/js/agent-editor.js` (mode state, detection, simple panel, model select, save path)
- Modify: `dashboard/frontend/styles.css` (append)

**Interfaces:**
- Consumes: Task 2's PATCH `model_name`; the create modal's `#builtinAgentModel` options (cloned so the two lists never drift); `SIMPLE_INSTRUCTION_*` values (byte-identical local copies — agent-editor.js is an IIFE and cannot see app.js file-scoped consts).
- Produces: editor opens in Simple for empty/1-step-simple pipelines, Advanced otherwise; Simple save writes the 1-step pipeline; both modes save `model_name`. `window.AgentEditor` API unchanged.

- [ ] **Step 1: app.html — editor header: model select + mode toggle.** Inside `agent-editor-title-wrap`, after the `agentEditorMeta` line (:756), add:

```html
                <label class="agent-editor-model-field" for="agentEditorModelSelect">
                    <span class="agent-editor-model-label">Model</span>
                    <select id="agentEditorModelSelect" class="agent-editor-model-select" aria-label="Agent model"></select>
                </label>
```

Inside `agent-editor-header-actions` (:763), before the dirty badge, add:

```html
                <div class="agent-editor-mode-toggle" role="group" aria-label="Editor mode">
                    <button id="agentEditorModeSimple" class="agent-editor-mode-btn" type="button">Simple</button>
                    <button id="agentEditorModeAdvanced" class="agent-editor-mode-btn" type="button">Advanced</button>
                </div>
```

- [ ] **Step 2: app.html — Simple panel + Advanced wrapper.** Inside `agent-editor-main` (:771), insert the Simple panel as the first child, and wrap the three existing Advanced elements (the intro card :772-780, `#agentEditorPipeline` :781, and the add-row :782-791) in a new `<div id="agentEditorAdvancedPanel">`:

```html
                <div class="agent-editor-main">
                    <div id="agentEditorSimplePanel" class="agent-editor-simple section-card compact" hidden>
                        <h3 class="agent-editor-intro-title">Trading instruction</h3>
                        <p class="agent-editor-intro-text">Tell the agent how to trade in plain language. Each market hour it sees prices and its portfolio, follows your instruction, and decides what to buy or sell.</p>
                        <textarea id="agentEditorSimpleInstruction" rows="6" maxlength="8000" placeholder="e.g. Spread the money across a few of the strongest available stocks. Buy on meaningful dips and take profits after strong run-ups." aria-label="Trading instruction"></textarea>
                        <p id="agentEditorSimpleReplaceNote" class="agent-editor-simple-note" hidden>This agent currently uses a multi-step pipeline. Saving in Simple mode replaces the pipeline with this one instruction.</p>
                    </div>
                    <div id="agentEditorAdvancedPanel">
                        <!-- existing intro card, #agentEditorPipeline, and add-row move in here UNCHANGED -->
                    </div>
                    <p id="agentEditorSaveStatus" class="agent-editor-save-status" hidden></p>
                    <p class="agent-editor-hint">Tip: use ↑↓ to reorder steps. Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.</p>
                </div>
```

(`agentEditorSaveStatus` and the hint stay outside the wrapper so save feedback is visible in both modes.)

- [ ] **Step 3: agent-editor.js — constants + mode state.** After `CASH_OVERRIDE_PREFIX` (:10), add:

```js
  const SIMPLE_PRESET_KEY = 'simple_instruction';
  // Must stay byte-identical to SIMPLE_INSTRUCTION_OUTPUT_FORMAT in app.js.
  const SIMPLE_OUTPUT_FORMAT =
    'JSON: { "orders": [{ "symbol": "...", "side": "buy|sell|hold", "qty": number, "order_type": "market|limit", "limit_price": number|null, "reason": "..." }] }';
```

Next to the `let currentAgent = null;` state block (:79-83), add:

```js
  let editorMode = 'simple';
```

- [ ] **Step 4: agent-editor.js — detection + stored-pipeline loader.** Add after `resolvePipeline` (:142-147):

```js
  function isSimplePipeline(pipeline) {
    return (
      !Array.isArray(pipeline) ||
      pipeline.length === 0 ||
      (pipeline.length === 1 && pipeline[0].presetKey === SIMPLE_PRESET_KEY)
    );
  }

  // The pipeline the agent ACTUALLY has (backend row, then local cache) — with
  // NO default-5-step substitution, so a fresh agent opens in Simple mode.
  // Demo agents keep resolvePipeline's default behavior.
  function loadStoredPipeline(agent) {
    if (Array.isArray(agent.pipeline) && agent.pipeline.length) {
      return agent.pipeline.map(normalizeLoadedSubAgent);
    }
    try {
      const raw = localStorage.getItem(storageKey(agent.agent_id));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.subAgents) && parsed.subAgents.length) {
          return parsed.subAgents.map(normalizeLoadedSubAgent);
        }
      }
    } catch {
      /* fall through to empty */
    }
    return [];
  }
```

- [ ] **Step 5: agent-editor.js — mode switching.** Add after `renderPipeline` (:415):

```js
  function updateSimpleReplaceNote() {
    const note = document.getElementById('agentEditorSimpleReplaceNote');
    if (note) note.hidden = !(editorMode === 'simple' && subAgents.length > 1);
  }

  function setEditorMode(mode) {
    editorMode = mode === 'advanced' ? 'advanced' : 'simple';
    const simplePanel = document.getElementById('agentEditorSimplePanel');
    const advancedPanel = document.getElementById('agentEditorAdvancedPanel');
    const resetBtn = document.getElementById('agentEditorResetBtn');
    if (simplePanel) simplePanel.hidden = editorMode !== 'simple';
    if (advancedPanel) advancedPanel.hidden = editorMode !== 'advanced';
    if (resetBtn) resetBtn.hidden = editorMode !== 'advanced';
    document.getElementById('agentEditorModeSimple')?.classList.toggle('active', editorMode === 'simple');
    document.getElementById('agentEditorModeAdvanced')?.classList.toggle('active', editorMode === 'advanced');
    if (editorMode === 'advanced' && subAgents.length === 0) {
      // First look at Advanced on a fresh agent: start from the default chain.
      subAgents = defaultPipeline();
      renderPipeline();
    }
    updateSimpleReplaceNote();
    markDirtyFromInput();
  }
```

- [ ] **Step 6: agent-editor.js — model select.** Add after `fillHeader` (:432):

```js
  function populateModelSelect(agent) {
    const select = document.getElementById('agentEditorModelSelect');
    if (!select) return;
    select.innerHTML = '';
    const seen = new Set();
    const source = document.getElementById('builtinAgentModel');
    if (source) {
      Array.from(source.options).forEach((opt) => {
        const clone = document.createElement('option');
        clone.value = opt.value;
        clone.textContent = opt.textContent;
        select.appendChild(clone);
        seen.add(opt.value);
      });
    }
    const current = agent.model_name || 'local-model';
    if (!seen.has(current)) {
      // External / legacy models aren't in the curated list — keep them selectable.
      const opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current;
      select.insertBefore(opt, select.firstChild);
    }
    select.value = current;
  }
```

And in `fillHeader` (:428-431), the meta line no longer duplicates the model (the select owns it now):

```js
    if (meta) {
      meta.textContent = agent.agent_type === 'builtin' ? 'Built-in agent' : 'External agent';
    }
```

- [ ] **Step 7: agent-editor.js — `getEditorState` collects mode + model + instruction.** Replace the `return` block (:187-192) with:

```js
    const modelSelect = document.getElementById('agentEditorModelSelect');
    let subAgentsOut;
    if (editorMode === 'simple') {
      const instruction = (
        document.getElementById('agentEditorSimpleInstruction')?.value || ''
      ).trim();
      if (instruction) {
        const existing =
          subAgents.length === 1 && subAgents[0].presetKey === SIMPLE_PRESET_KEY
            ? subAgents[0]
            : null;
        subAgentsOut = [
          {
            id: existing ? existing.id : newSubAgentId(),
            presetKey: SIMPLE_PRESET_KEY,
            label: 'Trading instruction',
            prompt: instruction,
            outputFormat: SIMPLE_OUTPUT_FORMAT,
          },
        ];
      } else {
        // Empty instruction never destroys an existing pipeline.
        subAgentsOut = subAgents;
      }
    } else {
      subAgentsOut = collectPipelineFromDom();
    }
    return {
      name: nameInput ? nameInput.value.trim() : '',
      description: descInput ? descInput.value.trim() : '',
      cash_allocation,
      model_name: modelSelect ? modelSelect.value : '',
      subAgents: subAgentsOut,
    };
```

- [ ] **Step 8: agent-editor.js — `open()` detects mode and fills the instruction.** Replace the top of `open` (:597-604) with:

```js
  function open(agent) {
    if (!agent || !agent.agent_id) return;

    currentAgent = { ...agent };
    if (isDemoAgent(agent.agent_id)) {
      subAgents = resolvePipeline(agent); // demo agents keep the legacy default chain
    } else {
      subAgents = loadStoredPipeline(agent);
    }
    fillHeader(agent);
    populateModelSelect(agent);
    const instructionEl = document.getElementById('agentEditorSimpleInstruction');
    if (instructionEl) {
      const simpleStep =
        subAgents.length === 1 && subAgents[0].presetKey === SIMPLE_PRESET_KEY
          ? subAgents[0]
          : null;
      instructionEl.value = simpleStep ? simpleStep.prompt : '';
    }
    renderPipeline();
    setEditorMode(isSimplePipeline(subAgents) ? 'simple' : 'advanced');
    refreshRunHistory(currentAgent);
```

(The rest of `open` — showing the view, `captureSavedSnapshot()`, focus — stays as-is. `captureSavedSnapshot` must remain AFTER the lines above so the snapshot includes mode-dependent state.)

- [ ] **Step 9: agent-editor.js — thread `model_name` through save.** In `patchAgent` (:444-450), add the parameter and payload field:

```js
  async function patchAgent(agent, name, description, pipeline, cash_allocation, model_name) {
    const payload = {
      name,
      description: description || null,
      pipeline: serializePipeline(pipeline),
      cash_allocation,
    };
    if (model_name) payload.model_name = model_name;
```

In `save()` (:698-705), pass it:

```js
      const updated = await patchAgent(
        currentAgent,
        state.name,
        state.description,
        subAgents,
        state.cash_allocation,
        state.model_name
      );
```

Also in `save()`, right after `subAgents = state.subAgents;` (:654), add:

```js
    updateSimpleReplaceNote();
```

(after a Simple save the pipeline is 1-step, so the replace-warning must clear).

- [ ] **Step 10: agent-editor.js — bind the toggle.** In `bindEvents` (:787), add:

```js
    document.getElementById('agentEditorModeSimple')?.addEventListener('click', () => setEditorMode('simple'));
    document.getElementById('agentEditorModeAdvanced')?.addEventListener('click', () => setEditorMode('advanced'));
```

Update the file header comment (:1-4) to mention the two modes:

```js
/**
 * agent-editor.js — Fullscreen agent Configure screen.
 * Simple mode: capital + one plain-language instruction (stored as a 1-step
 * pipeline) + model. Advanced mode: the multi-step sub-agent chain.
 * Agent fields: PATCH /api/v1/agents/{id}. Pipeline cache: localStorage.
 */
```

- [ ] **Step 11: styles.css — append:**

```css
/* Agent editor — Simple/Advanced modes (Demo 1) */
.agent-editor-mode-toggle {
    display: inline-flex;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
}
.agent-editor-mode-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-weight: 600;
    padding: 6px 14px;
    cursor: pointer;
}
.agent-editor-mode-btn.active {
    background: var(--border-color);
    color: var(--text-primary);
}
.agent-editor-model-field {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
}
.agent-editor-model-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
}
.agent-editor-model-select {
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 0.85rem;
    padding: 4px 8px;
}
.agent-editor-simple textarea {
    width: 100%;
    resize: vertical;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 0.95rem;
    line-height: 1.5;
    padding: 10px 12px;
    margin-top: 10px;
}
.agent-editor-simple-note {
    margin: 10px 0 0;
    font-size: 0.8rem;
    color: #fbbf24;
}
```

- [ ] **Step 12: Verify by serving the app.**

Checks (each against `http://localhost:8000/app`):
1. Configure on the provisioned default agent → opens in **Simple** with the starter instruction, model select showing DeepSeek V4 Pro, cash 1000.
2. Change model to GPT-5.5 + edit instruction + Save → "Saved successfully"; reload; both persist (model via Task 2's PATCH, instruction via pipeline).
3. Toggle Advanced → the one `Trading instruction` step renders in the pipeline UI (custom-preset fallback); toggle back → instruction intact.
4. Create a second builtin agent via Add Agent, open Configure, toggle Advanced on the fresh (empty) agent → default 5-step chain appears; Save; reopen → opens in **Advanced** (multi-step detection); switch to Simple → replace-note visible; Save with a non-empty instruction → pipeline is now 1 step; reopen → opens in Simple.
5. In Simple mode with the instruction cleared (empty textarea) on the multi-step agent → Save → pipeline unchanged (note still shown).
6. Ctrl+S saves in both modes; Escape closes; dirty badge appears on edits in both modes.

- [ ] **Step 13: Commit**

```bash
git add dashboard/frontend/app.html dashboard/frontend/js/agent-editor.js dashboard/frontend/styles.css
git commit -m "feat: Simple/Advanced Configure screen with editable model"
```

---

### Task 8: End-to-end verification (exit criterion) + suite

**Files:** none (verification only; fix-forward anything found, as its own commits)

- [ ] **Step 1: Full backend suite**

Run: `~/atl-venv/bin/python -m pytest dashboard/backend/tests/ -q`
Expected: all green, including the three route-freeze guards (`test_full_route_contract_unchanged`, `test_backtests_router_contract`, `test_agent_router_route_contract_unchanged`) — no route was added, so they must pass untouched. If `test_deleted_shim_is_not_importable` fails with "DID NOT RAISE", that's the stale-`__pycache__` phantom: `rm -rf dashboard/backend/engines dashboard/backend/services` and re-run.

- [ ] **Step 2: The exit-criterion click-through** (fresh browser profile / cleared localStorage, real backend, real `dashboard/.env` keys):

1. Open `http://localhost:8000/app` → My Agents.
2. **See** a default agent in the Foundation row (Default badge) and the Connect-your-own placeholder in the External row — no action needed.
3. Press **Configure** on the default agent → Simple screen: money, instruction, model.
4. Set cash 2,000, tweak the instruction, keep DeepSeek → Save.
5. Back → **Run Backtest** → a result renders (equity curve + metrics). The decision log should show the instruction-driven pipeline step (1-step pipeline reaches `run_pipeline_decision`; a parse failure degrades to hold, which is acceptable but should be rare).
6. Confirm the whole path needed **zero** knowledge of pipelines, presets, or JSON.

- [ ] **Step 3: Regression spot-checks**

- `?demo=1` still shows mock agents, grouped into the two rows, no auto-provision.
- An existing multi-step agent (create one via Advanced) still round-trips through Run Backtest.
- External-agent creation flow still works from the placeholder card and Add Agent.
- Delete / rotate-key / set-default all reachable from ⋮.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/my-agents-configure-run
```

PR title: `feat: My Agents configure-and-run rebuild (Demo 1)`. Body: 3-5 lines — two category rows, default agent, Configure button, Simple/Advanced editor, `model_name` PATCH + cap raise; link the spec file. Keep it concise per repo convention.

# Agentic FinSearch as a Leaderboard Trading Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Agentic FinSearch on the leaderboard exactly like the other model entries — AF-side professional-trader persona (direct, tools-off path, structurally guarded), ATL-side `finsearch` provider shim, config entry, pricing, then the contest run + seed refresh.

**Architecture:** Task 1 lands in the **Agentic-FinSearch repo** (persona prompt files + config-driven direct path: the tools-bypass and persona gates generalize, Buffet's HF-endpoint gates stay literal, and the unguarded research dispatch gains a direct-model guard). Tasks 2–5 land in **ATL** (provider module over the already-pinned `openai` SDK following the PR #96 pattern, leaderboard.json entry, pricing row, env docs). Task 6 is the run itself (smoke → budget gate → full window → seed-DB commit → budget revert).

**Tech Stack:** Django + OpenAI-compatible view (AF), `openai==1.101.0` SDK shim returning Anthropic-shaped objects (ATL), `deploy_leaderboard_model.py` (run), SQLite seed DB commit.

**Spec:** `docs/superpowers/specs/2026-07-13-finsearch-leaderboard-agent-design.md` — the spec's code/config blocks (§4.1 config, §4.2 persona text, §5 leaderboard entry) are the **single authoritative copies**; this plan references them instead of duplicating.

## Global Constraints

- **No look-ahead, structurally:** the shim hardcodes `mode: "normal"` (no env knob can select a tool-attached mode) and raises on any response with non-empty `sources` (AF's tool paths populate it; the direct path leaves it empty). AF-side, `direct: True` must route to the direct path for **every** mode and transport (spec §3).
- **Never pass `--allow-fallback`** to the deploy script — H6 exists to stop exactly that.
- **MODELS_CONFIG schema:** the model field key is **`model_name`** (read at `datascraper.py:219,524,1012`) and the streaming flag is **`streaming`** (read at `:1384`). Copy the spec §4.1 block exactly — earlier drafts with `model`/`supports_streaming` keys would make every call send `model=None`.
- ATL provider contract (from `providers/__init__.py:1-13` + the three existing modules): expose `INTEGRATION_ID`, `DEFAULT_MODEL`, `default_model_name()`, `make_client(anthropic_cls)`; `make_client` returns `None` and **never raises** — not just when the key is absent, but also when client construction fails (every sibling wraps the SDK-init in `try/except Exception: return None`; the documented contract in `providers/__init__.py` is "returns `None` when the SDK is missing or the integration's API key is unset / client init fails"). finsearch additionally prints a hint — its own choice, not a contract requirement; registered in `PROVIDERS`; never auto-selected.
- **Golden-set tests:** registering a provider changes `KNOWN_INTEGRATIONS` — `tests/llm/test_providers.py::test_known_integrations_are_parallel_siblings` (`:19-23`) hardcodes the integration set and must be updated in the same commit (same staleness family as the route-contract freezes that blocked PRs #88–#91).
- Seed-DB commits: regenerate via the deploy script, snapshot with `VACUUM INTO` from an isolated **detached** worktree, commit the binary + config diffs together. Always set `DATABASE_PATH` when smoke-testing so the committed seed stays clean.
- AF repo tests run via `cd Main/backend && uv run pytest`; ATL tests via `pytest dashboard/backend/tests/ -v` from the repo root.
- `CommonStack` hijack gotcha: `resolve_integration()` prefers CommonStack when `COMMONSTACK_API_KEY` is set and no integration is explicit — the leaderboard entry sets `"integration": "finsearch"` explicitly, so this cannot bite; do not remove that field.

---

### Task 1 (Agentic-FinSearch repo): trader persona + structurally-guarded direct path

**Repo:** `/mnt/d/FinGPT/Github/fingpt_rcos` — branch `flymiss_trader-persona`, PR per spec §4.3's branching note (default: PR to `main` per operational precedent #338/#354–#356; Felix may retarget to the CONTRIBUTING.md staging chain).

**Files:**
- Create: `Main/backend/prompts/personas/trader.md` (persona text: spec §4.2 — the authoritative copy)
- Create: `Main/backend/prompts/personas/buffett.md` (migrate `BUFFETT_INSTRUCTION` text verbatim)
- Modify: `Main/backend/datascraper/datascraper.py` — persona loader (same idiom as `_load_security_fragment`, `datascraper.py:66-75`); generalize the **tools-bypass** gates (`:1015` `create_agent_response`, `:1259` `create_agent_response_stream` — direct models route to the generic non-agent path) and **persona** selection (`:284` `_prepare_messages`) to config-driven `direct`/`persona`; add the research-mode dispatch guard in `create_advanced_response`. **Do NOT touch the `provider == "buffet"` checks inside `create_response` (`:531`) or its streaming twin** — those select Buffet's dedicated HF Inference Endpoint transport (`_call_buffet_agent`), and generalizing them would misroute every direct model into Buffet's fine-tuned endpoint instead of its own provider client (spec §3)
- Modify: `Main/backend/datascraper/models_config.py` — add the `FinSearch-Trader` entry **exactly as spec §4.1** (`model_name`/`streaming` keys); add `"direct": True, "persona": "buffett"` to `Buffet-Agent`
- Modify: `Docs/source/api_reference.rst` (model table row)
- Test: `Main/backend/tests/test_trader_persona.py` (new)

**Interfaces:**
- Produces: `MODELS_CONFIG["FinSearch-Trader"]` reachable via `POST /v1/chat/completions {"model": "FinSearch-Trader", "mode": "normal", ...}` on the direct path for every mode/transport; response is standard OpenAI shape with empty `sources`; `load_persona_instruction(name) -> str` loader.

- [ ] **Step 1: Write the failing tests**

```python
# Main/backend/tests/test_trader_persona.py
from datascraper.models_config import MODELS_CONFIG
from datascraper import datascraper as ds


def test_finsearch_trader_registered_with_real_schema_keys():
    cfg = MODELS_CONFIG["FinSearch-Trader"]
    assert cfg["direct"] is True
    assert cfg["persona"] == "trader"
    assert cfg["model_name"]            # the key every read site uses
    assert cfg["streaming"] is False    # the key datascraper.py:1384 reads
    assert "model" not in cfg or cfg.get("model_name")  # no dead 'model' key


def test_persona_loader_reads_prompt_files():
    trader = ds.load_persona_instruction("trader")
    buffett = ds.load_persona_instruction("buffett")
    assert "FinSearch Trader" in trader
    assert "Warren Buffett" in buffett


def test_prepare_messages_uses_trader_instruction():
    # real signature: _prepare_messages(message_list, user_input, model=None)
    # -> (msgs, system_message)   (datascraper.py:245-297)
    msgs, _system = ds._prepare_messages([], "What do you do?",
                                         model="FinSearch-Trader")
    joined = " ".join(m.get("content", "") for m in msgs)
    assert "FinSearch Trader" in joined          # persona applied
    assert "Warren Buffett" not in joined


def test_buffet_still_uses_buffett_instruction():
    msgs, _system = ds._prepare_messages([], "hi", model="Buffet-Agent")
    joined = " ".join(m.get("content", "") for m in msgs)
    assert "Warren Buffett" in joined


def test_direct_models_never_reach_tool_paths_or_buffet_endpoint():
    """Routing matrix: FinSearch-Trader x {normal, thinking, research} must
    reach the GENERIC provider dispatch — assert at the provider-client seam,
    NOT by patching create_response (which would hide misrouting inside it)."""
    # for each mode in ("normal", "thinking", "research"):
    #     patch (a) the agent-path entrypoint, (b) ds._call_buffet_agent,
    #     and (c) the provider client seam (the `clients` dict / the
    #     google/openai client's chat-completions call);
    #     call the mode's dispatch with model="FinSearch-Trader";
    #     assert: provider client seam WAS hit; agent path NOT hit;
    #             _call_buffet_agent NOT hit.
```

(There are **no** existing buffet tests in `tests/test_openai_api.py` — `grep -i buffet tests/` is empty, so build the routing-matrix assertions from scratch rather than copying a fixture that doesn't exist. The assertion seam must be the provider client / `_call_buffet_agent` level — a re-review of this plan caught that patching `create_response` itself would mask the exact misrouting bug the test exists to prevent. It must cover the **research** dispatch too, which today has no direct check at all.)

- [ ] **Step 2: Run to verify failure** — `cd Main/backend && uv run pytest tests/test_trader_persona.py -v` → FAIL (`KeyError: 'FinSearch-Trader'`).

- [ ] **Step 3: Implement.** Persona files per spec §4.2; loader:

```python
_PERSONA_DIR = Path(__file__).resolve().parent.parent / "prompts" / "personas"
_PERSONA_FALLBACKS = {"buffett": BUFFETT_INSTRUCTION}  # in-code fallback if file missing

def load_persona_instruction(name: str) -> str:
    path = _PERSONA_DIR / f"{name}.md"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return _PERSONA_FALLBACKS.get(name, INSTRUCTION)
```

In `_prepare_messages` (`:281-291`) replace the buffet literal with:

```python
    instruction = INSTRUCTION
    if model:
        model_config = get_model_config(model)
        persona = (model_config or {}).get("persona")
        if persona:
            instruction = load_persona_instruction(persona)
            logging.info("[PERSONA] Using %s system prompt", persona)
```

In `create_agent_response` (`:1015`) and `create_agent_response_stream` (`:1259`): replace `provider == "buffet"` with `model_config.get("direct")`, routing to the **generic non-agent path** (`create_response`/its streaming twin) — config now carries `direct: True` for buffet, no dead `or` disjunct. **Leave `create_response`'s internal `provider == "buffet"` branch (`:531`) and its streaming twin untouched** — inside `create_response`, that literal selects Buffet's HF endpoint transport; direct models with provider `google`/`openai` must fall through to the generic `clients.get(provider)` dispatch. In `create_advanced_response`: add the guard at entry — direct models return via the non-agent path before any research/tool machinery. `models_config.py` per spec §4.1.

- [ ] **Step 4: Run the new tests + the existing OpenAI-API suite**

Run: `cd Main/backend && uv run pytest tests/test_trader_persona.py tests/test_openai_api.py -v`
Expected: PASS (buffet behavior unchanged; `/v1/models` — `TestModelsList` only asserts `len(data["data"]) > 0` today, it does **not** pin a count, so add a positive assertion that `FinSearch-Trader` appears rather than bumping a nonexistent count).

- [ ] **Step 5: One manual live check** (needs env keys): `curl -s -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"FinSearch-Trader","mode":"normal","messages":[{"role":"user","content":"Reply with exactly the JSON {\"ok\": true} and nothing else."}]}'` → `choices[0].message.content` is exactly `{"ok": true}` (format compliance) and `sources` is `[]` (direct path). This is also the moment to verify provider `google` works on the direct path; if not, flip the entry to the sanctioned openai fallback (spec §9.1) and update the leaderboard `model` display string (spec §5).

- [ ] **Step 6: Docs + commit + PR.** Push `flymiss_trader-persona`, open the PR (body references this plan + spec), review before merging (loop protocol).

---

### Task 2 (ATL): `finsearch` provider module

**Files:**
- Create: `dashboard/backend/infrastructure/llm/providers/finsearch.py`
- Modify: `dashboard/backend/infrastructure/llm/providers/__init__.py:31-35` (register in `PROVIDERS`)
- Modify: `dashboard/backend/tests/llm/test_providers.py` — new finsearch cases **and** update `test_known_integrations_are_parallel_siblings` (`:19-23`) to the four-member set

**Interfaces:**
- Consumes: nothing from other tasks (independent of Task 1 until the run).
- Produces: `INTEGRATION_ID = "finsearch"`; `make_client(anthropic_cls) -> FinSearchClient | None`; `FinSearchClient.messages.create(model, max_tokens, messages, system=None, **kw)` returning an object with `.content` (one `type="text"` block) and `.usage.input_tokens/.output_tokens`; raises `LookAheadTripwire` on non-empty `sources`.

- [ ] **Step 1: Write the failing tests**

```python
# append to dashboard/backend/tests/llm/test_providers.py
from types import SimpleNamespace

import pytest

from dashboard.backend.infrastructure.llm.providers import (PROVIDERS,
                                                            resolve_integration)
from dashboard.backend.infrastructure.llm.providers import finsearch


def test_finsearch_registered():
    assert PROVIDERS["finsearch"] is finsearch
    assert finsearch.DEFAULT_MODEL == "FinSearch-Trader"
    assert finsearch.default_model_name() == "FinSearch-Trader"


def test_finsearch_never_auto_selected(monkeypatch):
    monkeypatch.delenv("COMMONSTACK_API_KEY", raising=False)
    assert resolve_integration(None) != "finsearch"


def test_finsearch_client_none_without_key(monkeypatch, capsys):
    monkeypatch.delenv("FINGPT_API_KEY", raising=False)
    assert finsearch.make_client(object) is None
    assert "FINGPT_API_KEY" in capsys.readouterr().out


def _fake_completion(content='{"actions": []}', sources=None):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(
            content=content, sources=sources), finish_reason="stop")],
        usage=SimpleNamespace(prompt_tokens=100, completion_tokens=8),
        sources=sources or [],
    )


class _FakeSDK:
    def __init__(self):
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self._response = _fake_completion()

    def _create(self, **kw):
        self.calls.append(kw)
        return self._response


def test_finsearch_messages_create_shapes_anthropic_response(monkeypatch):
    monkeypatch.setenv("FINGPT_API_KEY", "k")
    fake = _FakeSDK()
    monkeypatch.setattr(finsearch, "_make_sdk_client", lambda: fake)
    client = finsearch.make_client(object)
    resp = client.messages.create(
        model="FinSearch-Trader", max_tokens=2000,
        messages=[{"role": "user", "content": "prompt"}], system="sys",
    )
    call = fake.calls[0]
    assert call["model"] == "FinSearch-Trader"
    assert call["extra_body"] == {"mode": "normal"}   # hardcoded, no env knob
    assert call["messages"][0] == {"role": "system", "content": "sys"}
    assert resp.content[0].type == "text"
    assert resp.content[0].text == '{"actions": []}'
    assert resp.usage.input_tokens == 100 and resp.usage.output_tokens == 8


def test_finsearch_sources_tripwire(monkeypatch):
    """Non-empty sources == AF's tool path ran == look-ahead in a backtest.
    The shim must raise, never return tool-derived content as a decision."""
    monkeypatch.setenv("FINGPT_API_KEY", "k")
    fake = _FakeSDK()
    fake._response = _fake_completion(sources=[{"url": "https://example.com"}])
    monkeypatch.setattr(finsearch, "_make_sdk_client", lambda: fake)
    client = finsearch.make_client(object)
    with pytest.raises(finsearch.LookAheadTripwire):
        client.messages.create(model="FinSearch-Trader", max_tokens=10,
                               messages=[{"role": "user", "content": "p"}])
```

Also update `test_known_integrations_are_parallel_siblings` to `{"commonstack", "openrouter", "anthropic", "finsearch"}`.

- [ ] **Step 2: Run to verify failure** — `pytest dashboard/backend/tests/llm/test_providers.py -v -k finsearch` → FAIL (import error).

- [ ] **Step 3: Implement**

```python
# dashboard/backend/infrastructure/llm/providers/finsearch.py
"""Agentic FinSearch gateway — Anthropic-shaped shim over AF's OpenAI-compatible /v1.

Transport is the already-pinned `openai` SDK (base_url + api_key + retries for
free); this module only translates shapes. Contract asymmetries (accepted):
AF ignores max_tokens/temperature (LLM_MAX_OUTPUT_TOKENS is a no-op here);
AF's usage tokens are char-count estimates (len//4), so costs are approximate;
AF requires a `mode` field — hardcoded to "normal" (the tools-off invariant
must not be one env var away from violation). Non-empty `sources` in the
response means AF's tool path ran (look-ahead in a backtest) -> raise.
Note: make_llm_client() in providers/__init__.py gates on the `anthropic`
package importing BEFORE any provider dispatch, so this integration still
transitively needs anthropic installed even though the shim never uses it.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

INTEGRATION_ID = "finsearch"
DEFAULT_MODEL = "FinSearch-Trader"
DEFAULT_BASE_URL = "https://agenticfinsearch.org"
_TIMEOUT_SECONDS = 150  # AF's gunicorn kills at 120s; margin classifies failures client-side


class LookAheadTripwire(RuntimeError):
    """AF returned tool-derived sources on a path that must be tools-off."""


def default_model_name() -> str:
    return DEFAULT_MODEL


def _make_sdk_client():
    from openai import OpenAI  # pinned in requirements.txt (1.101.0)
    base = os.environ.get("FINSEARCH_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    return OpenAI(base_url=f"{base}/v1",
                  api_key=os.environ["FINGPT_API_KEY"],
                  timeout=_TIMEOUT_SECONDS, max_retries=1)


class _FinSearchMessages:
    def __init__(self):
        self._sdk = _make_sdk_client()

    def create(self, *, model, max_tokens=None, messages=None, system=None, **_):
        payload = list(messages or [])
        if system:
            payload.insert(0, {"role": "system", "content": system})
        resp = self._sdk.chat.completions.create(
            model=model or DEFAULT_MODEL,
            messages=payload,
            extra_body={"mode": "normal"},  # hardcoded: see module docstring
        )
        sources = getattr(resp, "sources", None) or []
        if sources:
            raise LookAheadTripwire(
                f"finsearch returned {len(sources)} tool-derived sources on a "
                "tools-off path — refusing to use the response")
        text = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)],
            usage=SimpleNamespace(
                input_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                output_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
            ),
        )


class FinSearchClient:
    def __init__(self):
        self.messages = _FinSearchMessages()


def make_client(anthropic_cls):
    if not os.environ.get("FINGPT_API_KEY"):
        print("[finsearch] FINGPT_API_KEY not set — finsearch integration unavailable")
        return None
    try:
        return FinSearchClient()
    except Exception as exc:  # SDK/env init failure -> None, matching every sibling
        # provider (commonstack/openrouter/anthropic_native all wrap construction
        # in try/except). The call chain (llm_agent._make_client ->
        # service.deploy_model_run -> CLI main) only catches LeaderboardFallbackError,
        # so an uncaught OpenAI(...) init error here would crash the whole deploy run
        # with a raw traceback instead of degrading to rule-based trading.
        print(f"[finsearch] client init failed: {exc}")
        return None
```

Register in `providers/__init__.py` `PROVIDERS` dict (import the module, add `finsearch.INTEGRATION_ID: finsearch`).

Implementation note: AF returns `sources` as a top-level response extension — verify at impl time whether the openai SDK surfaces it as an attribute or requires `resp.model_extra`/`resp.to_dict()`; the tripwire must read wherever it actually lands.

- [ ] **Step 4: Run** — `pytest dashboard/backend/tests/llm/test_providers.py -v` → PASS (including the updated `test_known_integrations_are_parallel_siblings`).

- [ ] **Step 5: Commit** — `git commit -m "feat(llm): finsearch provider — openai-SDK shim, tools-off tripwire"`.

---

### Task 3 (ATL): pricing row

**Files:**
- Modify: `dashboard/backend/infrastructure/llm/token_cost.py:27-58` (`_PRICING_TABLE`)
- Test: `dashboard/backend/tests/llm/` (wherever token-cost cases live — Grep `estimate_cost_usd` under tests)

- [ ] **Step 1: Failing test** — `estimate_cost_usd("FinSearch-Trader", 1_000_000, 1_000_000)` equals the underlying model's list price sum, not the `(1.0, 5.0)` default.

```python
def test_finsearch_trader_priced():
    from dashboard.backend.infrastructure.llm.token_cost import estimate_cost_usd
    cost = estimate_cost_usd("FinSearch-Trader", 1_000_000, 1_000_000)
    assert cost != 6.0  # not the default (1.0 + 5.0) — a real row must match first
```

- [ ] **Step 2: Add the row** — `("finsearch-trader", <in>, <out>)` at the underlying foundation model's **current list price** (verify the shipped model's published rate at impl time — gemini-3-flash-preview, or gpt-5.1-chat-latest if Task 1 fell back). **The needle MUST be lowercase.** `price_for_model()` lowercases the lookup name (`name = (model or "").strip().lower()`, `token_cost.py:98`) but matches with `if needle in name` **without** lowercasing the needle (`:103-105`), and every existing table row is already all-lowercase. A mixed-case `"FinSearch-Trader"` needle would never match (`"FinSearch-Trader" in "finsearch-trader"` is `False`), silently falling through to the `(1.0, 5.0)` default and failing Step 1's `assert cost != 6.0`. Comment the row with the upstream model + verification date.
- [ ] **Step 3: Run + commit** — `pytest dashboard/backend/tests/llm/ -v` → PASS; `git commit -m "feat(llm): FinSearch-Trader pricing row (approx upstream spend)"`.

---

### Task 4 (ATL): leaderboard entry + env + script docs

**Files:**
- Modify: `dashboard/config/leaderboard.json` — append the entry **exactly as spec §5** (the authoritative copy; note the `model` display string must name the underlying model + "tools off")
- Modify: `.env.example` — add `FINSEARCH_BASE_URL=` beside the OpenRouter block (`FINGPT_API_KEY` is added by Plan 1's Task 7; if that hasn't merged yet, add it here). **No `FINSEARCH_MODE`/`FINSEARCH_MODEL` vars** — deliberately not knobs.
- Modify: `dashboard/scripts/deploy_leaderboard_model.py` docstring (the required-secrets parenthetical at `:22-23` — lines 12-21 are the usage examples) — gains `FINGPT_API_KEY` for `finsearch`

- [ ] **Step 1: Apply the three edits.**
- [ ] **Step 2: Sanity test** — `python3 dashboard/scripts/deploy_leaderboard_model.py --entry agentic_finsearch --list` (**`--entry` is `required=True`** at `deploy_leaderboard_model.py:55` — bare `--list` exits 2 before listing) shows the entry with integration `finsearch`; `pytest dashboard/backend/tests/domain/leaderboard/ -v` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(leaderboard): Agentic FinSearch entry (finsearch integration, manual deploy)"`.

---

### Task 5 (ops): environment for the run

Manual checklist (no code):

- [ ] AF droplet: raise `AGENT_DAILY_RUN_BUDGET` to **1000** for the run window (env for the `fingpt-api` unit — same env file as `FINGPT_API_KEY`/`REQUIRE_FINGPT_API_KEY`). Sized for the worst case: the no-text retry ladder can bill up to 5 calls/step × 161 steps = 805, and the budget cliff is deterministic — once exhausted, every remaining step is a contiguous rule-based block that guarantees H6 rejection. **Reverting is Task 6 Step 5, not optional.**
- [ ] Local ATL `dashboard/.env`: `FINGPT_API_KEY=<the FinSearch backend key>`; optionally `FINSEARCH_BASE_URL` if targeting staging.
- [ ] Confirm AF prod is serving `FinSearch-Trader` (Task 1 merged + deployed): the Step-5 curl from Task 1, against `https://agenticfinsearch.org` (check `sources: []` too).

---

### Task 6: smoke run → budget gate → full run → seed refresh → revert

- [ ] **Step 1: Smoke (1 trading day, costs cents)**

```bash
DATABASE_PATH=/tmp/atl-smoke.db python3 dashboard/scripts/deploy_leaderboard_model.py \
  --entry agentic_finsearch --start 2026-04-15 --end 2026-04-16
```

Expected: exits 0; printed coverage 100% (or ≥95%); no `LeaderboardFallbackError`; **zero no-text retries in the output** (any retry = an AF-side format bug — fix there, don't tune ATL). If it exits 2, diagnose — do NOT proceed.

- [ ] **Step 2: Budget gate, then the full window.** Confirm the droplet raise is live (`ssh finsearch` → check the env file / a test call), **then**:

```bash
python3 dashboard/scripts/deploy_leaderboard_model.py --entry agentic_finsearch
```

(161 steps; direct path ≈ seconds/call plus per-call session setup AF-side — budget about an hour.) Expected: exits 0, H6 passes, run row written to `dashboard/storage/data/backtest.db`. The ~7-call smoke cannot catch a missing budget raise; skipping this gate deterministically fails H6 mid-run (contiguous 503 block — AF returns an OpenAI-style **503** for a daily-budget rejection, not 429; see spec §6).

- [ ] **Step 3: Seed refresh commit** (detached worktree + VACUUM INTO — `git worktree add /tmp/... main` fails whenever `main` is checked out in the primary working copy, which it normally is):

```bash
sqlite3 dashboard/storage/data/backtest.db "VACUUM INTO '/tmp/backtest-snapshot.db'"
git worktree add --detach /tmp/atl-seed-refresh origin/main
cp /tmp/backtest-snapshot.db /tmp/atl-seed-refresh/dashboard/storage/data/backtest.db
# branch + commit there alongside the leaderboard.json/provider diffs if not already merged
```

The leaderboard write is **additive** (one new `agent_runs` row; the seed runs referenced by `dashboard/config/defaults.json` are untouched) — but per the CLAUDE.md gotcha, verify the `defaults.json`-referenced runs still resolve against the new DB before committing (open the app locally against the snapshot; the default dashboard views must still load).

- [ ] **Step 4: Verify display** — locally: `uvicorn dashboard.backend.app:app` → `/app` → Competition → Leaderboard shows the entry (name "Agentic FinSearch", model string disclosing the underlying brain + tools-off) with curve, return, Sharpe — zero frontend edits. After merge: prod auto-deploys (PR #95 hook) → `GET /api/v1/leaderboard?refresh=true` → verify live.
- [ ] **Step 5: Revert the droplet `AGENT_DAILY_RUN_BUDGET` raise** (mandatory — a standing 10× budget quietly raises the shared droplet's abuse ceiling indefinitely).
- [ ] **Step 6: `/code-review` + merge** per the loop protocol.

---

## Verification (whole plan)

1. AF: `uv run pytest` green including the routing-matrix tests; live curl proves format compliance AND `sources: []`.
2. ATL: `pytest dashboard/backend/tests/ -v` fully green (including the updated `KNOWN_INTEGRATIONS` golden set).
3. H6 guard passes on the real full-window run — **the** acceptance gate.
4. Leaderboard page renders the entry with no frontend diff (`git diff --stat` shows none under `dashboard/frontend/`).
5. Budget raise reverted; both repos' PRs self-reviewed before merge.

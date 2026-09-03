# Agent & Strategy Persistence (`CONTENT_DATABASE_URL` Postgres backends) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents, agent versions, and strategies survive Render redeploys by storing them in Neon Postgres when `CONTENT_DATABASE_URL` is set, exactly mirroring the shipped `USERS_DATABASE_URL` users fix.

**Architecture:** Three hand-written Postgres twin classes (`PostgresAgentStore`, `PostgresAgentVersionStore`, `PostgresStrategyStore`) with public method surfaces identical to their SQLite originals, each selected by a module-level factory cloned from `users.py::_build_user_store()`. No base class, no ORM, no SQL-translation layer. Singleton names are unchanged, so zero caller changes.

**Tech Stack:** Python 3.13, FastAPI, sqlite3 (stdlib), psycopg 3 (`psycopg[binary]==3.3.4`, already a dependency), pytest.

**Spec:** `docs/superpowers/specs/2026-07-15-agent-strategy-persistence-design.md` — read it if any requirement here seems ambiguous; the spec wins.

## Global Constraints

- **Branch:** create `feat/agent-db-persistence` from current local `main` before Task 1 (`git checkout -b feat/agent-db-persistence`). NEVER push to `main` — merging `main` auto-deploys prod.
- **Dependency freeze:** `psycopg[binary]==3.3.4` is already at `requirements.txt:49`. Do NOT add any dependency.
- **Test command:** run from the repo root. `pytest` lives in `~/atl-venv`; if `pytest` is not on PATH use `~/atl-venv/bin/python -m pytest`.
- **Tasks 1–3 must land first, in order.** Task 1 stops the test suite from ever reaching a real Postgres via an ambient `CONTENT_DATABASE_URL`; Task 2 makes CI able to execute Postgres code at all (without it, every `@pg_only` test written in Tasks 5–7 silently skips and the whole Postgres half ships unrun); Task 3 defines the logging helper Tasks 4–7 all import. Do not reorder.
- **Singleton names unchanged:** `agent_store`, `agent_version_store`, `strategy_store`, `user_store` remain module-level names with the same import paths.
- **Postgres dialect conventions** (from `dashboard/backend/users_postgres.py`): per-call connections via `psycopg.connect(self.database_url, row_factory=dict_row)`; timestamps stored as `TEXT` ISO-8601 strings (the code always supplies values — never rely on DB-side defaults for timestamps); JSON stored as `TEXT` (not JSONB); SQLite `REAL` → `DOUBLE PRECISION`; `?` placeholders → `%s`.
- **Deliberate schema deviation:** `external_agents.owner_user_id` is a plain `INTEGER` with **no** FK — SQLite never enforced the declared FK (no `PRAGMA foreign_keys` anywhere), and a FK would break the split-database config (see spec).
- **Fail loud:** a set-but-unreachable `CONTENT_DATABASE_URL` must raise at import time (the twin's `__init__` runs `_init_schema()`). No try/except fallback to SQLite anywhere. Each twin gets a test pinning this (no live Postgres needed — a closed port refuses instantly); they are also the only tests that execute a twin's real `__init__`, since the dispatch tests monkeypatch the class away.
- **Fail visible:** every factory emits exactly one line stating the chosen backend (exact strings defined per task; tests assert on them). For the Postgres branch that line **must name the resolved host and database** — `postgres (ep-x.neon.tech/atl)`, never a bare `postgres`. A line that can't distinguish the intended database from the wrong one is not visibility; see the spec's "Failure semantics" section and CLAUDE.md's "Fail-closed is not fail-visible". The scoped `CONTENT_` name rules out an *accidental* collision, not a typo'd or staging-vs-prod URL — and nothing about it makes the silent unset→SQLite branch visible. The log line stays.
- **Emit with `print()`, never `logger.info()`.** This is not a style preference. Nothing under `dashboard/backend/` configures logging, no launch path passes `--log-level`, and uvicorn's `LOGGING_CONFIG` has no `root` key — so `dashboard.backend.*` loggers inherit root's default `WARNING` and **`logger.info()` emits nothing in prod** (verified: `isEnabledFor(INFO)` → `False`). Worse, a `caplog`-based test cannot catch that, because `caplog.at_level(logging.INFO, ...)` force-sets the level for the test: green suite, silent prod — the exact failure this feature exists to kill. `print()` is also the codebase's convention for operational diagnostics (~25 modules, incl. `app.py`'s startup block and `domain/leaderboard/service.py`). Tests assert on **`capsys`**, not `caplog`. Do not "tidy" these into a logger.
- **Log the target, never the credentials:** `CONTENT_DATABASE_URL` contains a password — no factory or twin may print the raw URL. Host/dbname comes from `describe_database_url()` (Task 3), which is defined **once** precisely so there is one place for that scrubbing to be right.
- **Commit style:** `feat:` / `test:` / `docs:` prefixes, short subject (repo convention).

## File Structure

| File | Action | Task | Responsibility |
|---|---|---|---|
| `dashboard/backend/tests/conftest.py` | Modify | 1 | Strip `CONTENT_DATABASE_URL` at import time (suite always SQLite) |
| `dashboard/backend/tests/test_env_isolation.py` | Create | 1 | Pin that the suite never sees the backend-selecting env vars |
| `.github/workflows/ci.yml` | Modify | 2 | `postgres:18-alpine` service + `TEST_POSTGRES_URL` → the `@pg_only` tier becomes a real gate |
| `dashboard/backend/tests/test_ci_postgres_wired.py` | Create | 2 | Make CI red (not silently all-skip) if the postgres service is ever dropped |
| `dashboard/backend/db_url.py` | Create | 3 | `describe_database_url()` — credential-free host/dbname for logs (shared by all 4 factories) |
| `dashboard/backend/tests/test_db_url.py` | Create | 3 | Pin that the password never survives the transformation |
| `dashboard/backend/users.py` | Modify | 4 | Backend log line only — selection stays `USERS_DATABASE_URL`, no fallback |
| `dashboard/backend/tests/test_users_postgres.py` | Modify | 4 | Scoping (ignores `CONTENT_DATABASE_URL`) + log-line dispatch tests + fail-loud test |
| `dashboard/backend/domain/agents/repository_postgres.py` | Create | 5 | `PostgresAgentStore` (twin of `AgentStore`) |
| `dashboard/backend/domain/agents/repository.py` | Modify | 5 | `_build_agent_store()` factory + log |
| `dashboard/backend/tests/test_agent_store_postgres.py` | Create | 5, 6 | Agent + version store dispatch, fail-loud, and `@pg_only` behavioral tests |
| `dashboard/backend/domain/agents/version_repository_postgres.py` | Create | 6 | `PostgresAgentVersionStore` (twin of `AgentVersionStore`) |
| `dashboard/backend/domain/agents/version_repository.py` | Modify | 6 | `_build_agent_version_store()` factory + log |
| `dashboard/backend/domain/strategies/repository_postgres.py` | Create | 7 | `PostgresStrategyStore` (twin of `StrategyStore`, ON CONFLICT retry) |
| `dashboard/backend/domain/strategies/repository.py` | Modify | 7 | `_build_strategy_store()` factory + log |
| `dashboard/backend/tests/domain/strategies/test_strategy_store.py` | **Modify** | 7 | Append SQLite forced-collision tests (new coverage for the existing backend) |
| `dashboard/backend/tests/test_strategy_store_postgres.py` | Create | 7 | Strategy dispatch, fail-loud, + `@pg_only` collision tests |
| `.env.example` | Modify | 8 | Document `CONTENT_DATABASE_URL` |
| `render.yaml` | Modify | 8 | `CONTENT_DATABASE_URL` with `sync: false` (documentation only) |
| `CLAUDE.md` | Modify | 8 | Env/credentials section + persistence gotcha |

> **`test_strategy_store.py` already exists — Modify, do not Create.** It lives at
> `dashboard/backend/tests/domain/strategies/test_strategy_store.py` (8 tests,
> including the `test_codes_are_unique` random-code check at lines 79-82 and a
> `_store(tmp_path)` helper at lines 18-19 the new tests should reuse). Creating a
> second file of the same basename under `dashboard/backend/tests/` would not raise a
> pytest import error — the tests tree is a package (`__init__.py` throughout), so
> both would import under distinct dotted names — it would just silently split one
> store's tests across two identically-named files. The other new test files
> (`test_agent_store_postgres.py`, `test_strategy_store_postgres.py`,
> `test_db_url.py`, `test_env_isolation.py`) have unique basenames and sit flat under
> `dashboard/backend/tests/`, mirroring the existing `test_users_postgres.py`.

**Import-cycle note (why the factories are safe):** each `repository_postgres.py` imports pure helpers from its SQLite sibling, and the sibling's factory imports the Postgres module *inside the factory function*, which runs at the bottom of the module — by then the helpers are already bound. This is exactly how `users.py` ↔ `users_postgres.py` already work.

**Live-Postgres testing (applies to every `@pg_only` test in this plan).** Locally, without `TEST_POSTGRES_URL` these tests skip. That is fine for fast iteration but it is **not** the definition of done: skipping locally *and* in CI is how ~450 lines of new SQL would reach prod unexecuted, and prod's first execution is `_init_schema()` at import time with fail-loud semantics. Task 2 therefore makes CI run them on every PR — that is the gate. Running them locally as well is the fast feedback loop:

```bash
docker run --rm -d --name atl-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=atl_test -p 5433:5432 postgres:18-alpine
export TEST_POSTGRES_URL=postgresql://postgres:test@localhost:5433/atl_test
# ... run pytest ...
docker stop atl-pg-test
```

Note the port differs by environment: **5433** locally (avoids clashing with a host Postgres on 5432) and **5432** in CI (the service container's own network). Only `TEST_POSTGRES_URL` encodes this — no test hardcodes a port.

**Not `@pg_only`, and deliberately so:** the fail-loud tests (an unreachable URL must raise) and `test_db_url.py`. Both need no server and must run in every environment, including a contributor's laptop with no docker.

---

### Task 1: Test-suite isolation — strip `CONTENT_DATABASE_URL` in conftest

Without this, a developer whose environment carries the prod `CONTENT_DATABASE_URL` — a sourced prod `.env`, a deploy shell — would run the entire test suite against the production Neon database the moment the factories (Tasks 4–7) exist. It lands first so that can never happen, even mid-implementation.

Calibrate the risk honestly: the scoped name (spec, Decision 2) means nothing *else* in the ecosystem sets this var, so the trigger is narrower than it would be for a Heroku-convention `DATABASE_URL` sitting in a shell for an unrelated project. It is not zero — the var still has to be somewhere for prod to work, and env inherits. Two lines of `os.environ.pop` against writing to the production database is not a trade worth thinking about, and the strip has a second job below that is unaffected by the naming.

It is also load-bearing for tests that *already* exist: once the factories are in, an ambient `CONTENT_DATABASE_URL` swaps the singletons for Postgres twins that have no `.db_path`, so `tests/domain/agents/test_repository_move.py:39-40` and `tests/domain/strategies/test_strategy_store.py:42-43` would fail with `AttributeError` rather than merely writing somewhere unexpected. (Tests that build a store directly rather than using the singleton are unaffected — `AgentStore.__init__` never reads the environment.)

**Files:**
- Modify: `dashboard/backend/tests/conftest.py:44-47`
- Test: `dashboard/backend/tests/test_env_isolation.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a guarantee later tasks rely on — inside the pytest process, `CONTENT_DATABASE_URL` and `USERS_DATABASE_URL` are always unset except where a test monkeypatches them.

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_env_isolation.py`:

```python
"""The suite must never see backend-selecting env vars from the developer's shell.

conftest.py pops them at import time -- before any backend module is imported,
which is the only moment that works, since the store singletons are built during
that import.

Scope, honestly: these tests assert the vars are absent *while the suite runs*.
They cannot prove the pop happens at conftest import time rather than in a
fixture, so they would stay green under a refactor that moved it somewhere
too late to matter. What they do catch is the pop being dropped outright, which
is the realistic regression. The import-time placement is guarded by the comment
at the pop itself.

Why this matters beyond "don't touch prod data": once the store factories exist,
an ambient CONTENT_DATABASE_URL doesn't merely redirect writes -- it swaps the singletons
for Postgres twins that have no .db_path, breaking the existing tests that assert
on it (tests/domain/agents/test_repository_move.py:39-40 and
tests/domain/strategies/test_strategy_store.py:42-43).
"""

import os


def test_users_database_url_is_stripped_for_the_suite():
    assert "USERS_DATABASE_URL" not in os.environ


def test_content_database_url_is_stripped_for_the_suite():
    assert "CONTENT_DATABASE_URL" not in os.environ
```

- [ ] **Step 2: Run the test to verify it fails when the var is set**

The strip must hold even when the developer's shell exports the var, so verify red with it set:

```bash
CONTENT_DATABASE_URL=postgresql://fake/db pytest dashboard/backend/tests/test_env_isolation.py -v
```

Expected: `test_content_database_url_is_stripped_for_the_suite` FAILS (conftest doesn't strip `CONTENT_DATABASE_URL` yet); the `USERS_DATABASE_URL` test PASSES (already stripped).

- [ ] **Step 3: Add the strip to conftest**

In `dashboard/backend/tests/conftest.py`, immediately after the existing `os.environ.pop("USERS_DATABASE_URL", None)` line (line 47), add:

```python
# Same guarantee for CONTENT_DATABASE_URL: it selects Postgres backends for the
# agent / agent-version / strategy stores, so a value inherited from the
# developer's environment (a sourced prod .env, a deploy shell) would point the
# whole test suite at a real database. Strip it before any backend module is
# imported.
os.environ.pop("CONTENT_DATABASE_URL", None)
```

Also update the module docstring's guarantee bullet (lines 23-25) to mention both vars:

```python
* An ambient ``USERS_DATABASE_URL`` or ``CONTENT_DATABASE_URL`` in the developer's
  shell can never make the test run reach for a real Postgres store: both are
  unset here for the same import-time reason ``DATABASE_PATH`` is pinned above.
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
CONTENT_DATABASE_URL=postgresql://fake/db pytest dashboard/backend/tests/test_env_isolation.py -v
```

Expected: 2 PASSED.

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/tests/conftest.py dashboard/backend/tests/test_env_isolation.py
git commit -m "test: strip CONTENT_DATABASE_URL from the suite environment"
```

---

### Task 2: CI runs a real Postgres — and the draft PR opens

Without this, every `@pg_only` test written in Tasks 5–7 skips in CI, and the three Postgres modules reach prod having never executed a single statement. Prod's first execution is `_init_schema()` at **import time** under fail-loud semantics, on a free-tier host with no zero-downtime deploys — so a DDL typo doesn't cause a bug, it causes an outage. This is the single highest-value task in the plan and it lands early, before any Postgres code exists, so the wiring is proven on its own commit.

It also switches on the shipped-but-never-CI-run `test_users_postgres.py` live tier. Expect that to be the first thing this task actually exercises; if it's red, that is a pre-existing defect in the users store surfacing for the first time, **not** something this branch broke. Fix it here (or open a separate issue) before continuing — do not proceed on a red baseline.

**Files:**
- Modify: `.github/workflows/ci.yml` (the `backend-tests` job)
- Test: `dashboard/backend/tests/test_ci_postgres_wired.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `TEST_POSTGRES_URL` set in CI → the `@pg_only` marker in Tasks 5–7 resolves to "run", not "skip".

- [ ] **Step 1: Write the guard test that makes the wiring self-enforcing**

A `services:` block someone deletes later fails *silently* — every `@pg_only` test just goes back to skipping and CI stays green. That is the same class of invisible-degradation this whole feature is about, so pin it. Create `dashboard/backend/tests/test_ci_postgres_wired.py`:

```python
"""CI must actually provide the live Postgres the @pg_only tier needs.

If the postgres service block is ever dropped from .github/workflows/ci.yml,
every @pg_only test silently reverts to skipping and CI stays green -- the
Postgres backends would then ship unexecuted, which is the exact failure this
tier exists to prevent. So the absence of the wiring is made loud, here.

Locally this test skips: a contributor without docker is expected, and their
@pg_only tests skipping is fine. It is only CI that must not skip them.
"""

import os

import pytest


@pytest.mark.skipif(
    not os.getenv("CI"), reason="asserts the CI wiring; local runs may skip @pg_only"
)
def test_ci_provides_a_live_postgres():
    assert os.getenv("TEST_POSTGRES_URL"), (
        "TEST_POSTGRES_URL is unset in CI, so every @pg_only test is silently "
        "skipping and the Postgres backends are untested. Restore the postgres "
        "service block in .github/workflows/ci.yml (backend-tests job)."
    )
```

(GitHub Actions sets `CI=true` on every runner; no workflow change is needed to make that check fire.)

- [ ] **Step 2: Run it locally to confirm it skips (not fails)**

```bash
pytest dashboard/backend/tests/test_ci_postgres_wired.py -v
CI=true pytest dashboard/backend/tests/test_ci_postgres_wired.py -v
```

Expected: 1 skipped for the first command; 1 **failed** for the second (simulating CI without the wiring) — that failure is the red this task turns green.

- [ ] **Step 3: Add the Postgres service to the `backend-tests` job**

In `.github/workflows/ci.yml`, add a `services:` key to the `backend-tests` job (a sibling of `steps:`, after `runs-on:`):

```yaml
    # A real Postgres for the @pg_only tier. Without it those tests skip and the
    # Postgres store backends would reach prod never having executed -- where the
    # first run is _init_schema() at import time, and a DDL error means the app
    # does not boot. Cheap insurance: the container starts in a couple of seconds.
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: atl_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
```

and add `TEST_POSTGRES_URL` to the existing `Run backend tests` step's `env:` block, alongside `DATABASE_PATH`:

```yaml
          # Selects the live tier of the *_postgres.py tests. Note this is NOT
          # CONTENT_DATABASE_URL: conftest.py strips that so the suite's own stores stay
          # on SQLite. This URL is only ever passed explicitly to a twin's
          # constructor by a @pg_only fixture.
          TEST_POSTGRES_URL: postgresql://postgres:test@localhost:5432/atl_test
```

The health-check options matter: without them the steps can start before Postgres accepts connections and the first `@pg_only` test fails on a race.

- [ ] **Step 4: Push and open the PR — as a DRAFT**

CI triggers on `pull_request` to `main` and on pushes to `main` only (see the `on:` block) — **pushing this branch alone runs nothing**, so the PR is how this task gets verified at all. And per CLAUDE.md's merge discipline, the PR must publish its own merge gate from the moment it opens, because this repo has no branch protection and open PRs get merged unreviewed:

```bash
git add .github/workflows/ci.yml dashboard/backend/tests/test_ci_postgres_wired.py
git commit -m "ci: run the @pg_only tier against a real Postgres"
git push -u origin feat/agent-db-persistence
gh pr create --draft \
  --title "feat: agent & strategy persistence via CONTENT_DATABASE_URL" \
  --body "$(cat <<'EOF'
DO NOT MERGE until `CONTENT_DATABASE_URL` is set in the Render dashboard — an unset var silently selects ephemeral SQLite, so merging first ships a feature that quietly does nothing. See `docs/superpowers/specs/2026-07-15-agent-strategy-persistence-design.md` (Rollout).

Optional Postgres backends for `external_agents`, `agent_versions`, and `strategies`, cloning the shipped `USERS_DATABASE_URL` users fix. Plan: `docs/superpowers/plans/2026-07-15-agent-strategy-persistence.md`.
EOF
)"
```

Keep it a draft for the rest of the plan. Task 9, Step 7 re-confirms it stays one — marking it ready is a **human** decision made after `CONTENT_DATABASE_URL` is set in Render, never a step this plan performs.

- [ ] **Step 5: Confirm CI actually ran the live tier**

```bash
gh run list --branch feat/agent-db-persistence --limit 1
gh run view <run-id> --log | grep -E "test_users_postgres|passed|skipped" | tail -20
```

Expected: green, and `test_users_postgres.py`'s two live tests now **pass rather than skip** (the run's skip count should drop by 2 versus a run without the service). `test_ci_provides_a_live_postgres` passing is the durable proof — it is the check that stays true for the life of the repo.

---

### Task 3: `describe_database_url()` — say *which* Postgres, without leaking the password

Every factory in Tasks 4–7 announces its chosen backend. For the Postgres branch, `backend: postgres` alone is not visibility: it reads identically whether the store bound to the intended Neon database, to staging, or to a URL with a typo'd host. The scoped `CONTENT_` name (spec, Decision 2) rules out an *accidental* collision; it does nothing about a wrong-but-deliberate value, which is what this line has to expose. So it names the host and database. That string comes from here.

Defined once, not cloned per store (which is otherwise this feature's pattern), for one reason: this is credential-scrubbing code, and four hand-copied scrubbers is four chances for one to leak the password into a log.

**Two traps this task exists to avoid, both of which produce a green suite and a silent prod:**

1. **The line must be `print()`, not `logger.info()`.** See the Global Constraints bullet: `dashboard.backend.*` loggers sit at `WARNING` in every real deployment, so `logger.info()` is dead code there — and `caplog.at_level(logging.INFO, ...)` in a test papers straight over it. `print()` has no level to suppress, so its visibility is structural rather than something a test has to defend.
2. **The helper must never echo unparseable input.** `urlsplit` dumps a psycopg keyword/DSN string (`host=… password=…`) wholesale into `.path` — so a "safe" fallback that reads `.path` would print the password verbatim, in exactly the branch nobody thinks to test. Key off `hostname` and return a constant instead.

**Files:**
- Create: `dashboard/backend/db_url.py`
- Test: `dashboard/backend/tests/test_db_url.py` (create)

**Interfaces:**
- Consumes: stdlib only (`urllib.parse.urlsplit`). Deliberately **not** psycopg: this must be importable from the SQLite path too, and a log helper should not drag in a driver.
- Produces: `describe_database_url(database_url: str) -> str` returning `host[:port]/dbname`. Imported by all four factories.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/backend/tests/test_db_url.py`:

```python
"""describe_database_url must name the target and never leak the credential.

It runs inside every store factory at import time, so it must also never raise:
a helper that explodes on an odd URL would take the app down to log a line.
"""

from dashboard.backend.db_url import describe_database_url


def test_describes_host_port_and_dbname():
    described = describe_database_url(
        "postgresql://u:pw@ep-x-pooler.eu-central-1.aws.neon.tech:5432/atl?sslmode=require"
    )
    assert described == "ep-x-pooler.eu-central-1.aws.neon.tech:5432/atl"


def test_omits_port_when_the_url_has_none():
    assert describe_database_url("postgresql://fake/db") == "fake/db"


def test_never_leaks_the_password():
    described = describe_database_url("postgresql://admin:sup3r-s3cret@host/db")
    assert described == "host/db"
    assert "sup3r-s3cret" not in described


def test_keyword_dsn_degrades_without_echoing_its_input():
    # psycopg also accepts keyword/DSN strings, which urlsplit cannot read: it
    # dumps the whole string into .path. Echoing that back would put the
    # password straight into the log -- so unparseable input returns a constant.
    dsn = "host=ep-x.neon.tech dbname=atl password=sup3r-s3cret"
    described = describe_database_url(dsn)
    assert described == "?/?"
    assert "sup3r-s3cret" not in described


def test_empty_and_junk_inputs_do_not_raise():
    assert describe_database_url("") == "?/?"
    assert describe_database_url("postgresql://host:notaport/db") == "?/?"
```

- [ ] **Step 2: Run to verify they fail**

```bash
pytest dashboard/backend/tests/test_db_url.py -v
```

Expected: all 5 fail with `ModuleNotFoundError: dashboard.backend.db_url`.

- [ ] **Step 3: Create `dashboard/backend/db_url.py`**

```python
"""Describe a database URL for logging, without leaking its credentials.

Used by every store factory (users, agents, agent versions, strategies) to log
*which* Postgres it bound to rather than merely that it bound to "postgres". A
bare backend name cannot distinguish the intended Neon database from staging, or
from a URL with a typo'd host -- they produce byte-identical startup logs, which
is the failure shape CLAUDE.md's "Fail-closed is not fail-visible" section exists
to warn about. (The scoped CONTENT_/USERS_ names rule out an *accidental*
collision with another tool's env var; they do nothing about a wrong value
deliberately set.)

Defined once rather than cloned into each store module (this feature's pattern
everywhere else) because it is credential-scrubbing code: four hand-copied
scrubbers is four chances for one of them to leak a password into a log.
"""

from __future__ import annotations

from urllib.parse import urlsplit


def describe_database_url(database_url: str) -> str:
    """Return ``host[:port]/dbname`` for ``database_url``, never its credentials.

    Returns ``"?/?"`` for anything not parseable as a URL. That constant is
    deliberate: psycopg also accepts keyword/DSN strings (``host=... dbname=...
    password=...``), and urlsplit puts the *entire* such string -- password
    included -- in ``.path``. Echoing any part of unparseable input back into a
    log is exactly the leak this helper exists to prevent, so it echoes nothing.
    Prod uses a URL, so the degraded case costs only log detail.

    Never raises: this runs inside a factory at import time, and a log helper
    that explodes on an odd URL would take the whole app down with it.
    """
    try:
        parts = urlsplit(database_url)
        host = parts.hostname
        port = f":{parts.port}" if parts.port else ""
    except ValueError:
        # urlsplit, or .port on a non-integer port, rejected the input.
        return "?/?"
    if not host:
        return "?/?"
    dbname = parts.path.lstrip("/") or "?"
    return f"{host}{port}/{dbname}"
```

- [ ] **Step 4: Run to verify they pass**

```bash
pytest dashboard/backend/tests/test_db_url.py -v
```

Expected: 5 PASSED.

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/db_url.py dashboard/backend/tests/test_db_url.py
git commit -m "feat: describe_database_url for credential-free backend logging"
```

---

### Task 4: Users factory — backend log line

The users store's **backend selection does not change**: it reads `USERS_DATABASE_URL`, alone, exactly as shipped. Per the spec's Decision 2 the vars are scoped per store, so there is no `CONTENT_DATABASE_URL` fallback here — a var named for user-created content has no business selecting the account database. This task adds the startup log line and nothing else.

It still lands before Tasks 5–7, and not because the users store needs it: this is where the factory shape those three tasks clone is fixed — against the one store already proven in prod, where a mistake in the shape is visible immediately rather than replicated three times.

**Files:**
- Modify: `dashboard/backend/users.py` (imports at top; `_build_user_store()` at lines 312-321)
- Test: `dashboard/backend/tests/test_users_postgres.py` (append)

**Interfaces:**
- Consumes: existing `UserStore`, `PostgresUserStore` (unchanged); `describe_database_url()` from Task 3.
- Produces: `_build_user_store()` still resolving `os.getenv("USERS_DATABASE_URL")` (unchanged), now emitting `"user_store backend: postgres (<host>/<db>)"` / `"user_store backend: sqlite (ephemeral on Render)"`. **Tasks 5–7 copy this exact factory shape** — get it right here.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/backend/tests/test_users_postgres.py`:

```python
def test_build_user_store_ignores_content_database_url(monkeypatch, capsys):
    """The two URLs are scoped per store (spec, Decision 2), and that separation
    is only a claim until something asserts it.

    This is the inverse of the precedence test the fallback design would have
    needed: CONTENT_DATABASE_URL must not reach the users store at all, not
    merely lose to USERS_DATABASE_URL. Without this, re-adding the fallback --
    a one-line "convenience" a future contributor could plausibly think is an
    improvement -- keeps the suite green while silently binding accounts to the
    content database.
    """
    import dashboard.backend.users as users_module

    monkeypatch.delenv("USERS_DATABASE_URL", raising=False)
    monkeypatch.setenv("CONTENT_DATABASE_URL", "postgresql://fake/content")

    store = users_module._build_user_store()

    assert isinstance(store, users_module.UserStore)
    # capsys, not caplog: the factory print()s. A caplog test would pass even if
    # the line were invisible in prod -- see the plan's Global Constraints.
    assert "user_store backend: sqlite (ephemeral on Render)" in capsys.readouterr().out


def test_build_user_store_announces_sqlite_backend(monkeypatch, capsys):
    import dashboard.backend.users as users_module

    monkeypatch.delenv("USERS_DATABASE_URL", raising=False)
    monkeypatch.delenv("CONTENT_DATABASE_URL", raising=False)
    store = users_module._build_user_store()
    assert isinstance(store, users_module.UserStore)
    assert "user_store backend: sqlite (ephemeral on Render)" in capsys.readouterr().out


def test_build_user_store_never_prints_the_credentials(monkeypatch, capsys):
    import dashboard.backend.users as users_module
    import dashboard.backend.users_postgres as users_postgres_module

    class FakePostgresUserStore:
        def __init__(self, database_url):
            pass

    monkeypatch.setattr(users_postgres_module, "PostgresUserStore", FakePostgresUserStore)
    monkeypatch.setenv("USERS_DATABASE_URL", "postgresql://admin:sup3r-s3cret@host/db")

    users_module._build_user_store()

    out = capsys.readouterr().out
    assert "sup3r-s3cret" not in out
    assert "user_store backend: postgres (host/db)" in out


def test_unreachable_postgres_raises_instead_of_falling_back():
    """Fail loud: a set-but-unreachable URL must not silently degrade to SQLite.

    This is the tier that exercises PostgresUserStore.__init__ for real -- the
    dispatch tests above monkeypatch the class away, so nothing else does. Needs
    no live Postgres: a closed port refuses instantly. connect_timeout keeps a
    firewall that DROPs rather than REJECTs from hanging the suite.
    """
    import psycopg

    from dashboard.backend.users_postgres import PostgresUserStore

    with pytest.raises(psycopg.OperationalError):
        PostgresUserStore("postgresql://u:p@127.0.0.1:1/nope?connect_timeout=2")
```

`test_users_postgres.py` already imports `pytest`; no new imports are needed at module level.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest dashboard/backend/tests/test_users_postgres.py -v
```

Expected: 3 of the 4 new tests FAIL — all three assert on output, and no factory prints anything yet. Note *why* `test_build_user_store_ignores_content_database_url` fails: not on the `isinstance` (today's factory already reads `USERS_DATABASE_URL` alone, so it returns a `UserStore` correctly), but on the missing log line. That is the honest red — the scoping half of it is a characterization of behavior this task must preserve, not build.

`test_unreachable_postgres_raises_instead_of_falling_back` **passes immediately**, and that is correct, not a mistake: `PostgresUserStore` already fails loud today. It is a characterization test — it pins behavior this task must not regress and that Tasks 5–7 must copy. The 2 pre-existing dispatch tests still PASS. `@pg_only` tests run in CI (Task 2) and skip locally without `TEST_POSTGRES_URL`.

- [ ] **Step 3: Implement**

In `dashboard/backend/users.py`, add the helper import alongside the existing `from dashboard.backend.database import DB_PATH`:

```python
from dashboard.backend.db_url import describe_database_url
```

No `import logging` and no module logger — see below. Replace `_build_user_store()` (lines 312-318) with:

```python
def _build_user_store():
    # USERS_DATABASE_URL only, deliberately: CONTENT_DATABASE_URL is scoped to
    # agents/versions/strategies and must not select the account database
    # (spec, Decision 2). Do not "simplify" this into a fallback chain.
    database_url = os.getenv("USERS_DATABASE_URL")
    if database_url:
        from dashboard.backend.users_postgres import PostgresUserStore

        # print(), not logger.info(): dashboard.backend.* loggers sit at WARNING
        # in every real deployment (nothing here configures logging; uvicorn's
        # LOGGING_CONFIG has no 'root' key), so an info() line would be invisible
        # exactly where it matters. Name the target too -- "postgres" alone reads
        # the same whether this is the intended Neon DB or a typo'd/staging URL.
        print(f"user_store backend: postgres ({describe_database_url(database_url)})")
        return PostgresUserStore(database_url)
    print("user_store backend: sqlite (ephemeral on Render)")
    return UserStore()
```

Two deliberate details: the line is emitted *before* the constructor, so a fail-loud crash still leaves a record of which target was being reached for — the first thing anyone debugging a boot failure wants. And `print` matches `app.py`'s startup diagnostics, which is what already reaches Render's logs today.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest dashboard/backend/tests/test_users_postgres.py dashboard/backend/tests/test_auth.py -v
```

Expected: all PASS (plus `@pg_only` skips). `test_auth.py` exercises the SQLite `UserStore` through the auth routes, proving the factory change didn't disturb the default path.

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/users.py dashboard/backend/tests/test_users_postgres.py
git commit -m "feat: users store logs its backend choice"
```

---

### Task 5: `PostgresAgentStore` + agent-store factory

The heart of the change: the twin of `AgentStore` (14 public methods) and the factory that selects it. `resolve_api_key()` is the sole auth path for `/api/v1` and `/api/v2` — port with care.

**Files:**
- Create: `dashboard/backend/domain/agents/repository_postgres.py`
- Modify: `dashboard/backend/domain/agents/repository.py` (imports; replace line 551 `agent_store = AgentStore()`)
- Test: `dashboard/backend/tests/test_agent_store_postgres.py` (create)

**Interfaces:**
- Consumes: pure helpers from the SQLite module — `DEFAULT_SCOPES`, `_UNSET`, `_utcnow_iso()`, `_hash_api_key(api_key: str) -> str`, `_new_api_key() -> str`, `_public_agent(row) -> Dict[str, Any]` (all defined at `repository.py:22-71`, before the factory runs — no import cycle).
- Produces: `PostgresAgentStore(database_url: str)` with methods signature-identical to `AgentStore`: `create_agent`, `register_or_get_agent`, `list_agents`, `list_builtin_agents`, `get_agent`, `get_agent_by_session`, `resolve_api_key`, `claim_browser_agents_to_user`, `claim_agent`, `reclaim_agent`, `rotate_api_key`, `update_agent`, `delete_agent`, `owns_agent`; plus `_get_connection()` (test fixtures call it). Factory `_build_agent_store()`; log lines `"agent_store backend: postgres (<host>/<db>)"` / `"agent_store backend: sqlite (ephemeral on Render)"`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/backend/tests/test_agent_store_postgres.py`:

```python
"""PostgresAgentStore / PostgresAgentVersionStore tests.

Two tiers, mirroring test_users_postgres.py:
1. Dispatch-logic tests (no live Postgres needed) - verify the module
   factories pick the right store class based on CONTENT_DATABASE_URL.
2. Behavioral tests against a real Postgres - skipped unless
   TEST_POSTGRES_URL is set. Point it at a throwaway database, e.g.:
     docker run --rm -e POSTGRES_PASSWORD=test -e POSTGRES_DB=atl_test \
       -p 5433:5432 postgres:18-alpine
     export TEST_POSTGRES_URL=postgresql://postgres:test@localhost:5433/atl_test

Do NOT copy the raw-SQL fixture pattern from test_v2_http_runs.py /
test_v2_auth.py (SQLite-only `?` placeholders); use public store methods.
"""

import os

import pytest

TEST_POSTGRES_URL = os.getenv("TEST_POSTGRES_URL")

pg_only = pytest.mark.skipif(
    not TEST_POSTGRES_URL,
    reason="TEST_POSTGRES_URL not set; skipping live-Postgres tests",
)


# --- dispatch tests (agent store) -------------------------------------------

def test_build_agent_store_defaults_to_sqlite(monkeypatch, capsys):
    import dashboard.backend.domain.agents.repository as repo_module

    monkeypatch.delenv("CONTENT_DATABASE_URL", raising=False)
    store = repo_module._build_agent_store()
    assert isinstance(store, repo_module.AgentStore)
    assert "agent_store backend: sqlite (ephemeral on Render)" in capsys.readouterr().out


def test_build_agent_store_picks_postgres_when_url_set(monkeypatch, capsys):
    import dashboard.backend.domain.agents.repository as repo_module
    import dashboard.backend.domain.agents.repository_postgres as repo_pg_module

    created = {}

    class FakePostgresAgentStore:
        def __init__(self, database_url):
            created["database_url"] = database_url

    monkeypatch.setattr(repo_pg_module, "PostgresAgentStore", FakePostgresAgentStore)
    monkeypatch.setenv("CONTENT_DATABASE_URL", "postgresql://fake/db")

    store = repo_module._build_agent_store()

    assert isinstance(store, FakePostgresAgentStore)
    assert created["database_url"] == "postgresql://fake/db"
    # capsys (the factory print()s) and the target is named -- see Task 3.
    assert "agent_store backend: postgres (fake/db)" in capsys.readouterr().out


def test_build_agent_store_never_prints_the_credentials(monkeypatch, capsys):
    import dashboard.backend.domain.agents.repository as repo_module
    import dashboard.backend.domain.agents.repository_postgres as repo_pg_module

    class FakePostgresAgentStore:
        def __init__(self, database_url):
            pass

    monkeypatch.setattr(repo_pg_module, "PostgresAgentStore", FakePostgresAgentStore)
    monkeypatch.setenv("CONTENT_DATABASE_URL", "postgresql://admin:sup3r-s3cret@host/db")

    repo_module._build_agent_store()

    out = capsys.readouterr().out
    assert "sup3r-s3cret" not in out
    assert "agent_store backend: postgres (host/db)" in out


def test_unreachable_postgres_agent_store_raises_instead_of_falling_back():
    """Fail loud: a set-but-unreachable URL must not silently degrade to SQLite.

    The only tier that runs PostgresAgentStore.__init__ (and therefore its
    _init_schema DDL path) without a live server -- the dispatch tests above
    monkeypatch the class away. A closed port refuses instantly; connect_timeout
    stops a DROP-style firewall from hanging the suite.
    """
    import psycopg

    from dashboard.backend.domain.agents.repository_postgres import PostgresAgentStore

    with pytest.raises(psycopg.OperationalError):
        PostgresAgentStore("postgresql://u:p@127.0.0.1:1/nope?connect_timeout=2")


# --- live-Postgres behavioral tests (agent store) ---------------------------

@pytest.fixture
def pg_agent_store():
    from dashboard.backend.domain.agents.repository_postgres import PostgresAgentStore

    store = PostgresAgentStore(TEST_POSTGRES_URL)
    with store._get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM external_agents")
    yield store


@pg_only
def test_agent_key_lifecycle_postgres(pg_agent_store):
    created = pg_agent_store.create_agent(
        name="PG Agent", owner_browser_session="bs_1", description="hello"
    )
    assert created["agent_id"].startswith("agent_")
    assert created["api_key"].startswith("ag_")
    assert created["api_key_prefix"] == created["api_key"][:12]

    resolved = pg_agent_store.resolve_api_key(created["api_key"])
    assert resolved is not None
    assert resolved["agent_id"] == created["agent_id"]
    assert resolved["last_used_at"] is not None

    new_key = pg_agent_store.rotate_api_key(created["agent_id"])
    assert new_key is not None and new_key != created["api_key"]
    assert pg_agent_store.resolve_api_key(created["api_key"]) is None
    assert pg_agent_store.resolve_api_key(new_key)["agent_id"] == created["agent_id"]

    assert pg_agent_store.rotate_api_key("agent_missing") is None
    assert pg_agent_store.resolve_api_key("") is None


@pg_only
def test_browser_claim_and_ownership_postgres(pg_agent_store):
    created = pg_agent_store.create_agent(name="Claimable", owner_browser_session="bs_2")
    assert pg_agent_store.owns_agent(created, owner_browser_session="bs_2") is True
    assert pg_agent_store.owns_agent(created, owner_user_id=42) is False

    claimed = pg_agent_store.claim_browser_agents_to_user("bs_2", user_id=42)
    assert claimed == 1
    assert pg_agent_store.owns_agent(created, owner_user_id=42) is True

    listed = pg_agent_store.list_agents(owner_user_id=42)
    assert [a["agent_id"] for a in listed] == [created["agent_id"]]
    assert listed[0]["owner_user_id"] == 42


@pg_only
def test_register_or_get_agent_is_idempotent_postgres(pg_agent_store):
    first = pg_agent_store.register_or_get_agent(session_id="sess-1", name="A")
    again = pg_agent_store.register_or_get_agent(session_id="sess-1", name="A renamed")
    assert again["agent_id"] == first["agent_id"]
    assert again["name"] == "A renamed"
    assert pg_agent_store.get_agent_by_session("sess-1")["agent_id"] == first["agent_id"]


@pg_only
def test_update_agent_partial_updates_postgres(pg_agent_store):
    created = pg_agent_store.create_agent(name="Updatable")

    updated = pg_agent_store.update_agent(
        created["agent_id"], name="Renamed", pipeline=[{"presetKey": "news"}]
    )
    assert updated["name"] == "Renamed"
    assert updated["pipeline"] == [{"presetKey": "news"}]

    # Omitted kwargs (the _UNSET sentinel) must leave stored fields untouched.
    updated2 = pg_agent_store.update_agent(created["agent_id"], description="desc only")
    assert updated2["description"] == "desc only"
    assert updated2["pipeline"] == [{"presetKey": "news"}]

    # Explicit None clears the pipeline.
    updated3 = pg_agent_store.update_agent(created["agent_id"], pipeline=None)
    assert updated3["pipeline"] is None

    # No kwargs at all returns the current record unchanged.
    same = pg_agent_store.update_agent(created["agent_id"])
    assert same["name"] == "Renamed"

    assert pg_agent_store.update_agent("agent_missing", name="X") is None


@pg_only
def test_builtin_listing_and_delete_postgres(pg_agent_store):
    builtin = pg_agent_store.create_agent(name="Builtin", agent_type="builtin")
    external = pg_agent_store.create_agent(name="External")

    builtin_ids = [a["agent_id"] for a in pg_agent_store.list_builtin_agents()]
    assert builtin["agent_id"] in builtin_ids
    assert external["agent_id"] not in builtin_ids

    assert pg_agent_store.delete_agent(builtin["agent_id"]) is True
    assert pg_agent_store.delete_agent(builtin["agent_id"]) is False
    assert pg_agent_store.get_agent(builtin["agent_id"]) is None
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest dashboard/backend/tests/test_agent_store_postgres.py -v
```

Expected: all 4 non-`@pg_only` tests FAIL — `test_build_agent_store_defaults_to_sqlite` with `AttributeError: module ... has no attribute '_build_agent_store'`; the other three with `ModuleNotFoundError` for `repository_postgres`. `@pg_only` tests skip locally (or ERROR on the missing module in CI, where `TEST_POSTGRES_URL` is now set — either is an acceptable red for this step).

- [ ] **Step 3: Create `dashboard/backend/domain/agents/repository_postgres.py`**

```python
"""Postgres-backed AgentStore implementation.

Selected instead of the default SQLite AgentStore when CONTENT_DATABASE_URL is set
(see repository.py's _build_agent_store). Exists because the SQLite store
lives in DATABASE_PATH, which resets to the committed seed database on every
deploy of the disk-less Render free-tier host -- silently deleting every
registered agent and invalidating every issued API key (resolve_api_key is
the sole auth path for /api/v1 and /api/v2). Method surface, return schemas,
and behavior are identical to AgentStore; only the SQL dialect differs.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional

import psycopg
from psycopg.rows import dict_row

from dashboard.backend.domain.agents.repository import (
    DEFAULT_SCOPES,
    _UNSET,
    _hash_api_key,
    _new_api_key,
    _public_agent,
    _utcnow_iso,
)


class PostgresAgentStore:
    """Persist external agents and their trading session IDs, backed by Postgres."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self._init_schema()

    def _get_connection(self) -> psycopg.Connection:
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def _init_schema(self) -> None:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                # owner_user_id is deliberately a plain INTEGER with no FK to
                # users(id): SQLite never enforced the declared FK (no PRAGMA
                # foreign_keys anywhere), the app owns this integrity
                # (owns_agent / claim_browser_agents_to_user), and a FK would
                # break the split config where USERS_DATABASE_URL points at a
                # different database (Postgres has no cross-database FKs).
                cur.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS external_agents (
                        agent_id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        session_id TEXT NOT NULL UNIQUE,
                        api_key_hash TEXT NOT NULL UNIQUE,
                        api_key_prefix TEXT NOT NULL,
                        model_name TEXT NOT NULL DEFAULT 'local-model',
                        scopes TEXT NOT NULL DEFAULT '{DEFAULT_SCOPES}',
                        owner_user_id INTEGER,
                        owner_browser_session TEXT,
                        created_at TEXT,
                        last_used_at TEXT,
                        agent_type TEXT NOT NULL DEFAULT 'external',
                        description TEXT,
                        pipeline_config TEXT,
                        cash_allocation DOUBLE PRECISION
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_external_agents_owner_user
                    ON external_agents(owner_user_id)
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_external_agents_owner_browser
                    ON external_agents(owner_browser_session)
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_external_agents_type
                    ON external_agents(agent_type)
                    """
                )

    def create_agent(
        self,
        *,
        name: str,
        model_name: str = "local-model",
        owner_user_id: Optional[int] = None,
        owner_browser_session: Optional[str] = None,
        session_id: Optional[str] = None,
        agent_type: str = "external",
        description: Optional[str] = None,
        cash_allocation: Optional[float] = None,
    ) -> Dict[str, Any]:
        agent_id = f"agent_{uuid.uuid4().hex[:12]}"
        session_id = session_id or str(uuid.uuid4())
        api_key = _new_api_key()
        api_key_hash = _hash_api_key(api_key)
        api_key_prefix = api_key[:12]
        now = _utcnow_iso()

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO external_agents (
                        agent_id, name, session_id, api_key_hash, api_key_prefix,
                        model_name, agent_type, description, cash_allocation,
                        owner_user_id, owner_browser_session, created_at, last_used_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        agent_id,
                        name.strip(),
                        session_id,
                        api_key_hash,
                        api_key_prefix,
                        model_name.strip() or "local-model",
                        (agent_type or "external").strip() or "external",
                        (description or None),
                        cash_allocation,
                        owner_user_id,
                        owner_browser_session,
                        now,
                        now,
                    ),
                )
                row = cur.fetchone()

        agent = _public_agent(row)
        agent["api_key"] = api_key
        return agent

    def register_or_get_agent(
        self,
        *,
        session_id: str,
        name: str,
        model_name: str = "local-model",
        owner_user_id: Optional[int] = None,
        owner_browser_session: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Link an existing trading session to an agent (idempotent)."""
        existing = self.get_agent_by_session(session_id)
        if existing:
            with self._get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE external_agents
                        SET name = %s, model_name = %s, last_used_at = %s,
                            owner_user_id = COALESCE(%s, owner_user_id),
                            owner_browser_session = COALESCE(%s, owner_browser_session)
                        WHERE session_id = %s
                        """,
                        (
                            name.strip(),
                            model_name.strip() or "local-model",
                            _utcnow_iso(),
                            owner_user_id,
                            owner_browser_session,
                            session_id,
                        ),
                    )
            return self.get_agent_by_session(session_id) or existing

        return self.create_agent(
            name=name,
            model_name=model_name,
            owner_user_id=owner_user_id,
            owner_browser_session=owner_browser_session,
            session_id=session_id,
        )

    def list_agents(
        self,
        *,
        owner_user_id: Optional[int] = None,
        owner_browser_session: Optional[str] = None,
        trading_session_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        seen: set = set()

        with self._get_connection() as conn:
            with conn.cursor() as cur:

                def _add_rows(query: str, params: tuple) -> None:
                    cur.execute(query, params)
                    for row in cur.fetchall():
                        if row["agent_id"] not in seen:
                            seen.add(row["agent_id"])
                            rows.append(row)

                if owner_user_id is not None:
                    _add_rows(
                        """
                        SELECT * FROM external_agents
                        WHERE owner_user_id = %s
                        ORDER BY created_at DESC
                        """,
                        (owner_user_id,),
                    )
                elif owner_browser_session:
                    _add_rows(
                        """
                        SELECT * FROM external_agents
                        WHERE owner_browser_session = %s
                        ORDER BY created_at DESC
                        """,
                        (owner_browser_session,),
                    )

                if trading_session_id:
                    _add_rows(
                        """
                        SELECT * FROM external_agents
                        WHERE session_id = %s
                        ORDER BY created_at DESC
                        """,
                        (trading_session_id,),
                    )

        return [_public_agent(row) for row in rows]

    def list_builtin_agents(self) -> List[Dict[str, Any]]:
        """List every built-in (platform-hosted) agent, newest first.

        Built-in agents are globally discoverable (e.g. from the Discord
        ``/agent`` command) regardless of which account created them.
        """
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT * FROM external_agents
                    WHERE agent_type = 'builtin'
                    ORDER BY created_at DESC
                    """
                )
                rows = cur.fetchall()
        return [_public_agent(row) for row in rows]

    def get_agent(self, agent_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM external_agents WHERE agent_id = %s", (agent_id,)
                )
                row = cur.fetchone()
        return _public_agent(row) if row else None

    def get_agent_by_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM external_agents WHERE session_id = %s", (session_id,)
                )
                row = cur.fetchone()
        return _public_agent(row) if row else None

    def resolve_api_key(self, api_key: str) -> Optional[Dict[str, Any]]:
        if not api_key or not api_key.strip():
            return None
        key_hash = _hash_api_key(api_key.strip())
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM external_agents WHERE api_key_hash = %s",
                    (key_hash,),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE external_agents SET last_used_at = %s WHERE agent_id = %s",
                        (_utcnow_iso(), row["agent_id"]),
                    )
        return _public_agent(row) if row else None

    def claim_browser_agents_to_user(
        self,
        browser_session: str,
        user_id: int,
    ) -> int:
        """Attach all browser-owned agents to a logged-in user account."""
        if not browser_session or user_id is None:
            return 0
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE external_agents
                    SET owner_user_id = %s,
                        owner_browser_session = COALESCE(owner_browser_session, %s),
                        last_used_at = %s
                    WHERE owner_browser_session = %s
                      AND (owner_user_id IS NULL OR owner_user_id = %s)
                    """,
                    (user_id, browser_session, _utcnow_iso(), browser_session, user_id),
                )
                updated = cur.rowcount
        return updated

    def claim_agent(
        self,
        agent_id: str,
        *,
        owner_user_id: Optional[int] = None,
        owner_browser_session: Optional[str] = None,
    ) -> None:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE external_agents
                    SET owner_user_id = COALESCE(%s, owner_user_id),
                        owner_browser_session = COALESCE(%s, owner_browser_session),
                        last_used_at = %s
                    WHERE agent_id = %s
                    """,
                    (owner_user_id, owner_browser_session, _utcnow_iso(), agent_id),
                )

    def reclaim_agent(
        self,
        agent_id: str,
        *,
        owner_user_id: Optional[int] = None,
        owner_browser_session: Optional[str] = None,
    ) -> None:
        """Re-bind an agent to the current browser/user (dashboard session proof)."""
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE external_agents
                    SET owner_user_id = COALESCE(%s, owner_user_id),
                        owner_browser_session = %s,
                        last_used_at = %s
                    WHERE agent_id = %s
                    """,
                    (owner_user_id, owner_browser_session, _utcnow_iso(), agent_id),
                )

    def rotate_api_key(self, agent_id: str) -> Optional[str]:
        """Issue a new API key for an agent. Returns the raw key once."""
        api_key = _new_api_key()
        api_key_hash = _hash_api_key(api_key)
        api_key_prefix = api_key[:12]
        now = _utcnow_iso()

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE external_agents
                    SET api_key_hash = %s,
                        api_key_prefix = %s,
                        last_used_at = %s
                    WHERE agent_id = %s
                    """,
                    (api_key_hash, api_key_prefix, now, agent_id),
                )
                updated = cur.rowcount > 0
        return api_key if updated else None

    def update_agent(
        self,
        agent_id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        pipeline: Any = _UNSET,
        cash_allocation: Any = _UNSET,
    ) -> Optional[Dict[str, Any]]:
        """Update display fields for an agent. Returns the updated record or None.

        ``pipeline`` uses a sentinel default so callers can distinguish "leave
        the stored pipeline untouched" (omit the arg) from "clear it" (pass
        ``None``). A list is serialized to JSON.
        """
        sets: list[str] = []
        params: list[Any] = []
        if name is not None:
            sets.append("name = %s")
            params.append(name.strip())
        if description is not None:
            sets.append("description = %s")
            params.append(description.strip() if description else None)
        if pipeline is not _UNSET:
            sets.append("pipeline_config = %s")
            params.append(json.dumps(pipeline) if pipeline else None)
        if cash_allocation is not _UNSET:
            sets.append("cash_allocation = %s")
            params.append(cash_allocation)
        if not sets:
            return self.get_agent(agent_id)
        sets.append("last_used_at = %s")
        params.append(_utcnow_iso())
        params.append(agent_id)
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE external_agents SET {', '.join(sets)} "
                    "WHERE agent_id = %s RETURNING *",
                    params,
                )
                row = cur.fetchone()
        return _public_agent(row) if row else None

    def delete_agent(self, agent_id: str) -> bool:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM external_agents WHERE agent_id = %s", (agent_id,)
                )
                deleted = cur.rowcount > 0
        return deleted

    def owns_agent(
        self,
        agent: Dict[str, Any],
        *,
        owner_user_id: Optional[int] = None,
        owner_browser_session: Optional[str] = None,
    ) -> bool:
        agent_id = agent.get("agent_id") if isinstance(agent, dict) else agent
        if not agent_id:
            return False
        # Read the ownership columns straight from the row. owner_browser_session
        # is deliberately omitted from the public agent dict (it is a private
        # credential), so we must NOT rely on the passed-in dict for it — doing so
        # is why owner_browser_session ownership silently never matched.
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT owner_user_id, owner_browser_session "
                    "FROM external_agents WHERE agent_id = %s",
                    (agent_id,),
                )
                row = cur.fetchone()
        if not row:
            return False
        if owner_user_id is not None and row["owner_user_id"] == owner_user_id:
            return True
        if owner_browser_session and row["owner_browser_session"] == owner_browser_session:
            return True
        # NOTE: session_id is NOT an ownership credential. It is an internal
        # trading-session identifier that is discoverable (it used to be returned
        # by the public /builtin listing), so matching it against a caller-supplied
        # session would let anyone who learned it take over the agent. Ownership
        # requires owner_user_id or owner_browser_session (a real, private
        # credential), or the agent API key (checked at the route layer).
        return False
```

- [ ] **Step 4: Add the factory to `dashboard/backend/domain/agents/repository.py`**

Add `import os` to the stdlib import block at the top (alphabetical order within the block — the module currently imports `hashlib, json, secrets, sqlite3, uuid`, so it isn't present yet), and add the helper import next to the existing `from dashboard.backend.database import DB_PATH`:

```python
from dashboard.backend.db_url import describe_database_url
```

No `import logging`, no module logger — the announcement is a `print()` (see Global Constraints). Replace the final line (`agent_store = AgentStore()`, line 551) with:

```python
def _build_agent_store():
    database_url = os.getenv("CONTENT_DATABASE_URL")
    if database_url:
        from dashboard.backend.domain.agents.repository_postgres import PostgresAgentStore

        # print(), not logger.info() -- info is invisible under the prod logging
        # config. See users.py's _build_user_store for the full rationale.
        print(f"agent_store backend: postgres ({describe_database_url(database_url)})")
        return PostgresAgentStore(database_url)
    print("agent_store backend: sqlite (ephemeral on Render)")
    return AgentStore()


agent_store = _build_agent_store()
```

(`domain/` → backend-root imports are already the norm here — this module imports `dashboard.backend.database` on line 20 — so `db_url` adds no new architectural edge and `test_architecture_boundaries.py` stays green. `print()` from a `domain/` module is likewise established: `domain/leaderboard/service.py`, `domain/runs/service.py`, and `domain/backtesting/*` all do it.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest dashboard/backend/tests/test_agent_store_postgres.py -v
```

Expected: the 4 non-`@pg_only` tests PASS; the 5 `@pg_only` tests skip locally and **PASS in CI** (Task 2 wired the service). Do not treat a local all-skip as done for this task — push and check the CI run, since that is the only place the twin's SQL executes.

- [ ] **Step 6: Run the whole suite (the factory touched a module every agent route imports)**

```bash
pytest dashboard/backend/tests/ -q
```

Expected: green (same skip count as before this task, +5 new skips without `TEST_POSTGRES_URL`). Note: if `test_deleted_shim_is_not_importable` fails with `DID NOT RAISE`, that's stale pre-refactor bytecode, not this change — `rm -rf dashboard/backend/engines dashboard/backend/services` and re-run (see CLAUDE.md gotchas).

- [ ] **Step 7: Commit**

```bash
git add dashboard/backend/domain/agents/repository_postgres.py dashboard/backend/domain/agents/repository.py dashboard/backend/tests/test_agent_store_postgres.py
git commit -m "feat: Postgres agent store behind CONTENT_DATABASE_URL"
```

---

### Task 6: `PostgresAgentVersionStore` + version-store factory

**Files:**
- Create: `dashboard/backend/domain/agents/version_repository_postgres.py`
- Modify: `dashboard/backend/domain/agents/version_repository.py` (imports; replace line 198 `agent_version_store = AgentVersionStore()`)
- Test: `dashboard/backend/tests/test_agent_store_postgres.py` (append)

**Interfaces:**
- Consumes: pure helpers from `version_repository.py` — `_utcnow_iso()`, `_new_version_id()`, `_short_hash(value) -> Optional[str]`, `_public_version(row) -> Dict[str, Any]` (defined at `version_repository.py:30-67`, before the factory runs). NOTE: this module's `_utcnow_iso` is its own copy — import from `version_repository`, not from `repository`.
- Produces: `PostgresAgentVersionStore(database_url: str)` with `create_version`, `get_version`, `list_versions` signature-identical to `AgentVersionStore`, plus `_get_connection()`. Factory `_build_agent_version_store()`; log lines `"agent_version_store backend: postgres (<host>/<db>)"` / `"agent_version_store backend: sqlite (ephemeral on Render)"`.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/backend/tests/test_agent_store_postgres.py`:

```python
# --- dispatch tests (agent version store) ------------------------------------

def test_build_agent_version_store_defaults_to_sqlite(monkeypatch, capsys):
    import dashboard.backend.domain.agents.version_repository as vrepo_module

    monkeypatch.delenv("CONTENT_DATABASE_URL", raising=False)
    store = vrepo_module._build_agent_version_store()
    assert isinstance(store, vrepo_module.AgentVersionStore)
    assert (
        "agent_version_store backend: sqlite (ephemeral on Render)"
        in capsys.readouterr().out
    )


def test_build_agent_version_store_picks_postgres_when_url_set(monkeypatch, capsys):
    import dashboard.backend.domain.agents.version_repository as vrepo_module
    import dashboard.backend.domain.agents.version_repository_postgres as vrepo_pg_module

    created = {}

    class FakePostgresAgentVersionStore:
        def __init__(self, database_url):
            created["database_url"] = database_url

    monkeypatch.setattr(
        vrepo_pg_module, "PostgresAgentVersionStore", FakePostgresAgentVersionStore
    )
    monkeypatch.setenv("CONTENT_DATABASE_URL", "postgresql://fake/db")

    store = vrepo_module._build_agent_version_store()

    assert isinstance(store, FakePostgresAgentVersionStore)
    assert created["database_url"] == "postgresql://fake/db"
    assert "agent_version_store backend: postgres (fake/db)" in capsys.readouterr().out


def test_unreachable_postgres_version_store_raises_instead_of_falling_back():
    """Fail loud — see the agent-store twin of this test above."""
    import psycopg

    from dashboard.backend.domain.agents.version_repository_postgres import (
        PostgresAgentVersionStore,
    )

    with pytest.raises(psycopg.OperationalError):
        PostgresAgentVersionStore("postgresql://u:p@127.0.0.1:1/nope?connect_timeout=2")


# --- live-Postgres behavioral tests (agent version store) --------------------

@pytest.fixture
def pg_version_store():
    from dashboard.backend.domain.agents.version_repository_postgres import (
        PostgresAgentVersionStore,
    )

    store = PostgresAgentVersionStore(TEST_POSTGRES_URL)
    with store._get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM agent_versions")
    yield store


@pg_only
def test_version_create_get_list_postgres(pg_version_store):
    v1 = pg_version_store.create_version(
        agent_id="agent_x",
        version="1.0",
        model_backbones=["claude-sonnet-5"],
        prompt="You are a trader.",
        config={"risk": "low"},
    )
    assert v1["agent_version_id"].startswith("agv_")
    assert v1["model_backbones"] == ["claude-sonnet-5"]
    # Hashes derived from raw prompt/config when not passed explicitly.
    assert v1["prompt_hash"] and len(v1["prompt_hash"]) == 16
    assert v1["config_hash"] and len(v1["config_hash"]) == 16

    v2 = pg_version_store.create_version(agent_id="agent_x", version="1.1")
    listed = pg_version_store.list_versions("agent_x")
    # Both creates can land in the same second (1s timestamp resolution), and
    # the tiebreak is agent_version_id DESC (random hex) — so assert membership
    # and count, not a specific order.
    assert {v["agent_version_id"] for v in listed} == {
        v1["agent_version_id"],
        v2["agent_version_id"],
    }
    assert len(listed) == 2

    fetched = pg_version_store.get_version(v1["agent_version_id"])
    assert fetched == v1
    assert pg_version_store.get_version("agv_missing") is None
    assert pg_version_store.list_versions("agent_other") == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest dashboard/backend/tests/test_agent_store_postgres.py -v
```

Expected: `test_build_agent_version_store_defaults_to_sqlite` FAILS with `AttributeError` (no `_build_agent_version_store`); the picks-postgres and fail-loud tests FAIL with `ModuleNotFoundError` for `version_repository_postgres`. Task 5's agent-store tests, which live in this same file, still PASS.

- [ ] **Step 3: Create `dashboard/backend/domain/agents/version_repository_postgres.py`**

```python
"""Postgres-backed AgentVersionStore implementation.

Selected instead of the default SQLite AgentVersionStore when CONTENT_DATABASE_URL is
set (see version_repository.py's _build_agent_version_store). Versions are
immutable reproducibility snapshots and were previously lost with their agents
on every deploy of the disk-less Render free-tier host. Method surface, return
schemas, and behavior are identical to AgentVersionStore; only the SQL dialect
differs.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import psycopg
from psycopg.rows import dict_row

from dashboard.backend.domain.agents.version_repository import (
    _new_version_id,
    _public_version,
    _short_hash,
    _utcnow_iso,
)


class PostgresAgentVersionStore:
    """Persist immutable agent version snapshots, backed by Postgres."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self._init_schema()

    def _get_connection(self) -> psycopg.Connection:
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def _init_schema(self) -> None:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS agent_versions (
                        agent_version_id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        version TEXT NOT NULL,
                        execution_mode TEXT NOT NULL DEFAULT 'external',
                        architecture TEXT,
                        model_backbones TEXT NOT NULL DEFAULT '[]',
                        decision_frequency TEXT NOT NULL DEFAULT '1h',
                        code_commit TEXT,
                        prompt_hash TEXT,
                        config_hash TEXT,
                        verification_level TEXT NOT NULL DEFAULT 'self_reported',
                        created_at TEXT
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_agent_versions_agent
                    ON agent_versions(agent_id, created_at)
                    """
                )

    def create_version(
        self,
        *,
        agent_id: str,
        version: str,
        execution_mode: str = "external",
        architecture: Optional[str] = None,
        model_backbones: Optional[List[str]] = None,
        decision_frequency: str = "1h",
        code_commit: Optional[str] = None,
        prompt_hash: Optional[str] = None,
        config_hash: Optional[str] = None,
        prompt: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        verification_level: str = "self_reported",
    ) -> Dict[str, Any]:
        """Create a new immutable version. Hashes can be derived from raw
        prompt/config if explicit hashes are not provided."""
        agent_version_id = _new_version_id()
        now = _utcnow_iso()
        backbones = json.dumps(list(model_backbones or []))
        prompt_hash = prompt_hash or _short_hash(prompt)
        config_hash = config_hash or _short_hash(config)

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO agent_versions (
                        agent_version_id, agent_id, version, execution_mode, architecture,
                        model_backbones, decision_frequency, code_commit, prompt_hash,
                        config_hash, verification_level, created_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        agent_version_id,
                        agent_id,
                        version,
                        execution_mode,
                        architecture,
                        backbones,
                        decision_frequency,
                        code_commit,
                        prompt_hash,
                        config_hash,
                        verification_level,
                        now,
                    ),
                )
                row = cur.fetchone()
        return _public_version(row)

    def get_version(self, agent_version_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM agent_versions WHERE agent_version_id = %s",
                    (agent_version_id,),
                )
                row = cur.fetchone()
        return _public_version(row) if row else None

    def list_versions(self, agent_id: str) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT * FROM agent_versions
                    WHERE agent_id = %s
                    ORDER BY created_at DESC, agent_version_id DESC
                    """,
                    (agent_id,),
                )
                rows = cur.fetchall()
        return [_public_version(row) for row in rows]
```

- [ ] **Step 4: Add the factory to `dashboard/backend/domain/agents/version_repository.py`**

Add `import os` to the stdlib import block at the top and `from dashboard.backend.db_url import describe_database_url` next to the existing `from dashboard.backend.database import DB_PATH`. No logger — the announcement is a `print()` (see Global Constraints).

Replace the final line (`agent_version_store = AgentVersionStore()`, line 198) with:

```python
def _build_agent_version_store():
    database_url = os.getenv("CONTENT_DATABASE_URL")
    if database_url:
        from dashboard.backend.domain.agents.version_repository_postgres import (
            PostgresAgentVersionStore,
        )

        # print(), not logger.info() -- see users.py's _build_user_store.
        print(
            "agent_version_store backend: postgres "
            f"({describe_database_url(database_url)})"
        )
        return PostgresAgentVersionStore(database_url)
    print("agent_version_store backend: sqlite (ephemeral on Render)")
    return AgentVersionStore()


agent_version_store = _build_agent_version_store()
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest dashboard/backend/tests/test_agent_store_postgres.py -v
```

Expected: all dispatch tests PASS; `@pg_only` skip (or PASS with live Postgres).

- [ ] **Step 6: Commit**

```bash
git add dashboard/backend/domain/agents/version_repository_postgres.py dashboard/backend/domain/agents/version_repository.py dashboard/backend/tests/test_agent_store_postgres.py
git commit -m "feat: Postgres agent version store behind CONTENT_DATABASE_URL"
```

---

### Task 7: `PostgresStrategyStore` (restructured share-code retry) + strategy factory + collision tests

The one non-mechanical port. `StrategyStore.create()` (`domain/strategies/repository.py:95-128`) catches `sqlite3.IntegrityError` per attempt and retries **on the same connection**. In Postgres the first `UniqueViolation` aborts the transaction and every later statement on that connection raises `InFailedSqlTransaction` — a literal port 500s on the first real collision. The Postgres twin instead uses `INSERT ... ON CONFLICT (code) DO NOTHING` and treats `cursor.rowcount == 0` as the collision signal. Retry count (20), the widened 16-char fallback, and the final `RuntimeError` are preserved exactly.

No existing test forces a collision on *either* backend, so this task also adds SQLite collision tests (new coverage, runs everywhere).

**Files:**
- Create: `dashboard/backend/domain/strategies/repository_postgres.py`
- Modify: `dashboard/backend/domain/strategies/repository.py` (imports; replace line 156 `strategy_store = StrategyStore()`)
- **Modify:** `dashboard/backend/tests/domain/strategies/test_strategy_store.py` (append SQLite collision tests — this file **already exists**; do not create a second one, see the File Structure note)
- Test: `dashboard/backend/tests/test_strategy_store_postgres.py` (create — dispatch + fail-loud + `@pg_only`)

**Interfaces:**
- Consumes: from `domain/strategies/repository.py` — `_CODE_LENGTH` (int, = 8), `_now_iso()` (NOTE: this module's timestamp helper keeps microseconds and is named `_now_iso`, unlike the agent modules' `_utcnow_iso`), `_public(row) -> dict`.
- Produces: `PostgresStrategyStore(database_url: str)` with `create`, `get`, `set_last_run` signature-identical to `StrategyStore`, plus `_get_connection()`. Factory `_build_strategy_store()`; log lines `"strategy_store backend: postgres (<host>/<db>)"` / `"strategy_store backend: sqlite (ephemeral on Render)"`. The module-level wrappers `create_strategy`/`get_strategy`/`set_last_run` keep delegating to the `strategy_store` singleton unchanged.

- [ ] **Step 1: Append the SQLite collision tests to the existing test file**

⚠️ **`dashboard/backend/tests/domain/strategies/test_strategy_store.py` already exists** (8 tests). Append to it; do not create a second `test_strategy_store.py` under `dashboard/backend/tests/`.

Add to its import block (which currently has `import uuid`, `import pytest`, `from fastapi.testclient import TestClient`, `from dashboard.backend.app import app`, `from dashboard.backend.domain.strategies.repository import StrategyStore`):

```python
import dashboard.backend.domain.strategies.repository as strategies_module
```

Then append after `test_codes_are_unique` (line 82) and **before** the `Router integration` section, reusing the file's existing `_store(tmp_path)` helper rather than adding a fixture:

```python
# ----------------------------------------------------------------------
# Share-code collision retry.
#
# test_codes_are_unique above can't reach this: random 8-hex codes never
# collide by chance, so the retry loop has been dead code to the suite until
# now. These force the collision instead of mocking the insert. The Postgres
# twin mirrors them exactly (test_strategy_store_postgres.py) -- its loop is
# structurally different (ON CONFLICT DO NOTHING + rowcount rather than
# catching IntegrityError, since a UniqueViolation would abort the whole
# transaction) and must behave identically.
# ----------------------------------------------------------------------


def test_create_retries_past_a_code_collision(tmp_path, monkeypatch):
    store = _store(tmp_path)
    first = store.create(prompt="first strategy")

    codes = iter([first["code"], "fresh456"])
    # NB: strategies_module.secrets IS the stdlib secrets module, so this
    # patches token_hex process-wide rather than just this module's view of
    # it. Harmless -- monkeypatch restores it and nothing else in this test
    # calls token_hex -- but don't read it as module-scoped.
    monkeypatch.setattr(
        strategies_module.secrets, "token_hex", lambda nbytes: next(codes)
    )

    second = store.create(prompt="second strategy")
    assert second["code"] == "fresh456"
    assert store.get(first["code"])["prompt"] == "first strategy"
    assert store.get("fresh456")["prompt"] == "second strategy"


def test_create_widens_code_space_after_20_collisions(tmp_path, monkeypatch):
    store = _store(tmp_path)
    first = store.create(prompt="first strategy")

    calls = {"n": 0}

    def fake_token_hex(nbytes):
        calls["n"] += 1
        if calls["n"] <= 20:
            return first["code"]  # every narrow attempt collides
        return "w" * 16  # the widened attempt succeeds

    monkeypatch.setattr(strategies_module.secrets, "token_hex", fake_token_hex)

    second = store.create(prompt="second strategy")
    assert second["code"] == "w" * 16
    # 20 narrow attempts (token_hex(_CODE_LENGTH // 2) -> 8 chars) + 1 widened
    # (token_hex(_CODE_LENGTH) -> 16 chars). See repository.py:112-124.
    assert calls["n"] == 21


def test_create_raises_when_even_widened_code_collides(tmp_path, monkeypatch):
    store = _store(tmp_path)
    first = store.create(prompt="first strategy")

    monkeypatch.setattr(
        strategies_module.secrets, "token_hex", lambda nbytes: first["code"]
    )

    with pytest.raises(RuntimeError):
        store.create(prompt="second strategy")
```

- [ ] **Step 2: Run the SQLite collision tests**

```bash
pytest dashboard/backend/tests/domain/strategies/test_strategy_store.py -v
```

Expected: **11 PASSED** (8 pre-existing + 3 new). Unlike every other task here, these are green on arrival by design — they characterize *existing* SQLite behavior and must be proven correct before the Postgres twin is written against them. A failure means the retry loop was misread: stop and re-read `repository.py:95-128` rather than adjusting the test.

- [ ] **Step 3: Write the failing dispatch + Postgres tests**

Create `dashboard/backend/tests/test_strategy_store_postgres.py`:

```python
"""PostgresStrategyStore tests.

Dispatch tests need no live Postgres. Behavioral tests run only when
TEST_POSTGRES_URL is set (see test_users_postgres.py's docstring for the
docker recipe). The collision tests mirror test_strategy_store.py exactly:
the Postgres retry loop is structurally different (ON CONFLICT DO NOTHING +
rowcount, because a UniqueViolation would abort the transaction) and must
behave identically to SQLite's catch-and-retry.
"""

import os

import pytest

TEST_POSTGRES_URL = os.getenv("TEST_POSTGRES_URL")

pg_only = pytest.mark.skipif(
    not TEST_POSTGRES_URL,
    reason="TEST_POSTGRES_URL not set; skipping live-Postgres tests",
)


# --- dispatch tests ----------------------------------------------------------

def test_build_strategy_store_defaults_to_sqlite(monkeypatch, capsys):
    import dashboard.backend.domain.strategies.repository as strategies_module

    monkeypatch.delenv("CONTENT_DATABASE_URL", raising=False)
    store = strategies_module._build_strategy_store()
    assert isinstance(store, strategies_module.StrategyStore)
    assert "strategy_store backend: sqlite (ephemeral on Render)" in capsys.readouterr().out


def test_build_strategy_store_picks_postgres_when_url_set(monkeypatch, capsys):
    import dashboard.backend.domain.strategies.repository as strategies_module
    import dashboard.backend.domain.strategies.repository_postgres as strategies_pg_module

    created = {}

    class FakePostgresStrategyStore:
        def __init__(self, database_url):
            created["database_url"] = database_url

    monkeypatch.setattr(
        strategies_pg_module, "PostgresStrategyStore", FakePostgresStrategyStore
    )
    monkeypatch.setenv("CONTENT_DATABASE_URL", "postgresql://fake/db")

    store = strategies_module._build_strategy_store()

    assert isinstance(store, FakePostgresStrategyStore)
    assert created["database_url"] == "postgresql://fake/db"
    assert "strategy_store backend: postgres (fake/db)" in capsys.readouterr().out


def test_unreachable_postgres_strategy_store_raises_instead_of_falling_back():
    """Fail loud — see the agent-store twin of this test."""
    import psycopg

    from dashboard.backend.domain.strategies.repository_postgres import (
        PostgresStrategyStore,
    )

    with pytest.raises(psycopg.OperationalError):
        PostgresStrategyStore("postgresql://u:p@127.0.0.1:1/nope?connect_timeout=2")


# --- live-Postgres behavioral tests ------------------------------------------

@pytest.fixture
def pg_strategy_store():
    from dashboard.backend.domain.strategies.repository_postgres import (
        PostgresStrategyStore,
    )

    store = PostgresStrategyStore(TEST_POSTGRES_URL)
    with store._get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM strategies")
    yield store


@pg_only
def test_create_get_set_last_run_postgres(pg_strategy_store):
    created = pg_strategy_store.create(
        prompt="buy the dip", description="  classic  ", owner="discord:123"
    )
    assert len(created["code"]) == 8
    assert created["description"] == "classic"
    assert created["last_run_id"] is None

    fetched = pg_strategy_store.get(created["code"])
    assert fetched == created
    assert pg_strategy_store.get("missing0") is None
    assert pg_strategy_store.get("") is None

    updated = pg_strategy_store.set_last_run(created["code"], "run_abc")
    assert updated["last_run_id"] == "run_abc"
    assert updated["last_run_at"] is not None
    assert pg_strategy_store.set_last_run("missing0", "run_abc") is None

    with pytest.raises(ValueError):
        pg_strategy_store.create(prompt="   ")


@pg_only
def test_create_retries_past_a_code_collision_postgres(pg_strategy_store, monkeypatch):
    import dashboard.backend.domain.strategies.repository_postgres as strategies_pg_module

    first = pg_strategy_store.create(prompt="first strategy")

    codes = iter([first["code"], "fresh456"])
    monkeypatch.setattr(
        strategies_pg_module.secrets, "token_hex", lambda nbytes: next(codes)
    )

    second = pg_strategy_store.create(prompt="second strategy")
    assert second["code"] == "fresh456"
    assert pg_strategy_store.get(first["code"])["prompt"] == "first strategy"


@pg_only
def test_create_widens_code_space_after_20_collisions_postgres(
    pg_strategy_store, monkeypatch
):
    import dashboard.backend.domain.strategies.repository_postgres as strategies_pg_module

    first = pg_strategy_store.create(prompt="first strategy")

    calls = {"n": 0}

    def fake_token_hex(nbytes):
        calls["n"] += 1
        if calls["n"] <= 20:
            return first["code"]
        return "w" * 16

    monkeypatch.setattr(strategies_pg_module.secrets, "token_hex", fake_token_hex)

    second = pg_strategy_store.create(prompt="second strategy")
    assert second["code"] == "w" * 16
    assert calls["n"] == 21


@pg_only
def test_create_raises_when_even_widened_code_collides_postgres(
    pg_strategy_store, monkeypatch
):
    import dashboard.backend.domain.strategies.repository_postgres as strategies_pg_module

    first = pg_strategy_store.create(prompt="first strategy")

    monkeypatch.setattr(
        strategies_pg_module.secrets, "token_hex", lambda nbytes: first["code"]
    )

    with pytest.raises(RuntimeError):
        pg_strategy_store.create(prompt="second strategy")
```

- [ ] **Step 4: Run to verify the dispatch tests fail**

```bash
pytest dashboard/backend/tests/test_strategy_store_postgres.py -v
```

Expected: `test_build_strategy_store_defaults_to_sqlite` FAILS with `AttributeError` (no `_build_strategy_store`); the picks-postgres and fail-loud tests FAIL with `ModuleNotFoundError` for `repository_postgres`; `@pg_only` skip locally (error in CI, which is an acceptable red for this step).

- [ ] **Step 5: Create `dashboard/backend/domain/strategies/repository_postgres.py`**

```python
"""Postgres-backed StrategyStore implementation.

Selected instead of the default SQLite StrategyStore when CONTENT_DATABASE_URL is set
(see repository.py's _build_strategy_store). Method surface and behavior are
identical to StrategyStore, with one structural difference: the share-code
retry loop uses ``INSERT ... ON CONFLICT (code) DO NOTHING`` and checks
``cursor.rowcount`` instead of catching IntegrityError. In Postgres a
UniqueViolation aborts the whole transaction (every later statement on the
connection raises InFailedSqlTransaction), so SQLite's catch-and-retry on one
connection cannot be ported literally -- it would 500 on the first real
collision. Retry count, code-space widening, and the RuntimeError fallback
are preserved exactly.
"""

from __future__ import annotations

import secrets
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

from dashboard.backend.domain.strategies.repository import (
    _CODE_LENGTH,
    _now_iso,
    _public,
)


class PostgresStrategyStore:
    """Persist free-form strategy prompts, backed by Postgres."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self._init_schema()

    def _get_connection(self) -> psycopg.Connection:
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def _init_schema(self) -> None:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS strategies (
                        code TEXT PRIMARY KEY,
                        prompt TEXT NOT NULL,
                        description TEXT,
                        source TEXT,
                        owner TEXT,
                        created_at TEXT,
                        last_run_id TEXT,
                        last_run_at TEXT
                    )
                    """
                )

    def create(
        self,
        *,
        prompt: str,
        description: Optional[str] = None,
        source: Optional[str] = None,
        owner: Optional[str] = None,
    ) -> dict[str, Any]:
        cleaned = (prompt or "").strip()
        if not cleaned:
            raise ValueError("Strategy prompt cannot be empty.")
        desc = (description or "").strip() or None
        now = _now_iso()
        with self._get_connection() as conn:
            with conn.cursor() as cur:

                def _insert(candidate: str) -> bool:
                    # ON CONFLICT DO NOTHING + rowcount instead of catching
                    # UniqueViolation: an aborted transaction would poison the
                    # connection for every retry (see module docstring).
                    cur.execute(
                        "INSERT INTO strategies "
                        "(code, prompt, description, source, owner, created_at, last_run_id, last_run_at) "
                        "VALUES (%s, %s, %s, %s, %s, %s, NULL, NULL) "
                        "ON CONFLICT (code) DO NOTHING",
                        (candidate, cleaned, desc, source or None, owner or None, now),
                    )
                    return cur.rowcount == 1

                code = None
                for _ in range(20):
                    candidate = secrets.token_hex(_CODE_LENGTH // 2)
                    if _insert(candidate):
                        code = candidate
                        break
                if code is None:
                    # Astronomically unlikely: widen the code space (64 bits) and
                    # try once more, matching the SQLite store's graceful fallback
                    # rather than surfacing a 500.
                    candidate = secrets.token_hex(_CODE_LENGTH)
                    if not _insert(candidate):
                        raise RuntimeError("Could not allocate a unique strategy code")
                    code = candidate
                cur.execute("SELECT * FROM strategies WHERE code = %s", (code,))
                row = cur.fetchone()
                return _public(row)

    def get(self, code: str) -> Optional[dict[str, Any]]:
        if not code:
            return None
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM strategies WHERE code = %s", (code,))
                row = cur.fetchone()
        return _public(row) if row else None

    def set_last_run(self, code: str, run_id: str) -> Optional[dict[str, Any]]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE strategies SET last_run_id = %s, last_run_at = %s "
                    "WHERE code = %s RETURNING *",
                    (run_id, _now_iso(), code),
                )
                row = cur.fetchone()
        return _public(row) if row else None
```

- [ ] **Step 6: Add the factory to `dashboard/backend/domain/strategies/repository.py`**

Add `import os` to the stdlib import block at the top and `from dashboard.backend.db_url import describe_database_url` next to the existing `from dashboard.backend.database import DB_PATH`. No logger — the announcement is a `print()` (see Global Constraints).

Replace `strategy_store = StrategyStore()` (line 156) with:

```python
def _build_strategy_store():
    database_url = os.getenv("CONTENT_DATABASE_URL")
    if database_url:
        from dashboard.backend.domain.strategies.repository_postgres import (
            PostgresStrategyStore,
        )

        # print(), not logger.info() -- see users.py's _build_user_store.
        print(f"strategy_store backend: postgres ({describe_database_url(database_url)})")
        return PostgresStrategyStore(database_url)
    print("strategy_store backend: sqlite (ephemeral on Render)")
    return StrategyStore()


strategy_store = _build_strategy_store()
```

Leave the module-level `create_strategy` / `get_strategy` / `set_last_run` wrappers below it untouched — they delegate through the singleton name.

- [ ] **Step 7: Run tests to verify they pass**

```bash
pytest dashboard/backend/tests/domain/strategies/test_strategy_store.py \
       dashboard/backend/tests/test_strategy_store_postgres.py \
       dashboard/backend/tests/test_strategies_api.py -v
```

Expected: SQLite collision tests + dispatch tests + fail-loud test + existing strategies API tests all PASS; `@pg_only` skip locally, PASS in CI.

- [ ] **Step 8: Commit**

```bash
git add dashboard/backend/domain/strategies/repository_postgres.py dashboard/backend/domain/strategies/repository.py dashboard/backend/tests/domain/strategies/test_strategy_store.py dashboard/backend/tests/test_strategy_store_postgres.py
git commit -m "feat: Postgres strategy store behind CONTENT_DATABASE_URL"
```

---

### Task 8: Config & developer-docs surface

No code, no tests — documentation the deploy depends on. (User-facing hosted docs are explicitly out of scope for this branch; see the spec's follow-ups section.)

**Files:**
- Modify: `.env.example` (after the `USERS_DATABASE_URL` block, lines 76-83)
- Modify: `render.yaml` (envVars list)
- Modify: `CLAUDE.md` ("Environment & credentials" section and the account-persistence gotcha)

**Interfaces:**
- Consumes: the factory behavior from Tasks 4-7 (must describe it accurately, including the host/db log format from Task 3).
- Produces: nothing programmatic.

- [ ] **Step 1: Document `CONTENT_DATABASE_URL` in `.env.example`**

Insert after the `# USERS_DATABASE_URL=postgresql://user:password@host/dbname` line:

```bash
# User-created content (optional). When set, agents, agent versions, and
# strategies are stored in this Postgres database instead of the local SQLite
# file above -- required on ephemeral hosts (Render free tier) where
# DATABASE_PATH resets on every deploy, deleting every registered agent and
# invalidating every issued agent API key. Covers content only: accounts are
# selected separately by USERS_DATABASE_URL above, and neither var falls back
# to the other -- set BOTH for a fully durable deployment, pointed at the SAME
# database so user->agent ownership stays joinable. Deliberately not named
# DATABASE_URL: that name is the Heroku convention a managed-Postgres add-on
# injects on its own, and an inherited value would silently bind this app to
# someone else's database. Use a pooled connection string (e.g. Neon's
# "-pooler" host) since each store call opens a new connection. Leave unset for
# local dev.
# CONTENT_DATABASE_URL=postgresql://user:password@host/dbname
```

- [ ] **Step 2: Add `CONTENT_DATABASE_URL` to `render.yaml` as documentation**

In the `envVars` list, after the `DATABASE_PATH` entry, add:

```yaml
      # Durable Postgres for user-created content (agents, versions,
      # strategies). Accounts are separate: USERS_DATABASE_URL. Set in the
      # Render dashboard BEFORE merging the feature -- this yaml is
      # documentation, not the mechanism (prod does not sync from it; see
      # CLAUDE.md "Prod deploy reality").
      - key: CONTENT_DATABASE_URL
        sync: false
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the **Environment & credentials** section, after the `USERS_DATABASE_URL` bullet, add:

```markdown
- `CONTENT_DATABASE_URL` (optional): when set, agents (`external_agents`), agent versions, and strategies are stored in this Postgres database instead of `DATABASE_PATH` SQLite (factories in each store module, cloned from `_build_user_store()`; Postgres twins in `*_postgres.py` siblings). It covers *user-created content* only; accounts have their own `USERS_DATABASE_URL` and the two never fall back to each other — a fully durable deployment sets both, pointed at the same Neon DB, pooled (`-pooler`) URL. **Not** named `DATABASE_URL` on purpose: that is the Heroku-convention name managed-Postgres add-ons inject and unrelated projects export, and an ambient value would silently bind the app to the wrong database (nothing can protect a local `uvicorn` run from it — reading the env var *is* the feature). Set it in the **Render dashboard before merging** anything that depends on it — unset silently selects ephemeral SQLite, which is why each factory logs its choice at startup: `<store> backend: postgres (<host>/<db>)` or `<store> backend: sqlite (ephemeral on Render)`. The line names the host/db rather than a bare "postgres" so a typo'd or staging URL is visible too (`db_url.py::describe_database_url`, which never emits credentials). Leave unset for local dev/tests — `tests/conftest.py` strips it so the suite always runs on SQLite.
```

In the **Gotchas** section, extend the user-accounts bullet (the one starting "**User accounts were silently lost on every prod redeploy until 2026-07**") by appending to it:

```markdown
The same fix was extended to agents, agent versions, and strategies in 2026-07 via `CONTENT_DATABASE_URL` (see `docs/superpowers/specs/2026-07-15-agent-strategy-persistence-design.md`) — before that, every registered agent and issued API key died on each deploy, breaking all SDK/Discord integrations, with `resolve_api_key()` as the sole auth path for `/api/v1` and `/api/v2`.
```

- [ ] **Step 4: Verify nothing broke**

```bash
pytest dashboard/backend/tests/ -q
```

Expected: green (docs-only change; this is a cheap regression tripwire before commit).

- [ ] **Step 5: Commit**

```bash
git add .env.example render.yaml CLAUDE.md
git commit -m "docs: document CONTENT_DATABASE_URL config surface"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: a green **draft** PR, ready for human review — and explicitly *not* ready to merge (see Step 7).

- [ ] **Step 1: Clear stale bytecode (known phantom-failure source)**

```bash
rm -rf dashboard/backend/engines dashboard/backend/services
find dashboard -name __pycache__ -type d -prune -exec rm -rf {} +
```

- [ ] **Step 2: Run the full backend suite**

```bash
pytest dashboard/backend/tests/ -v 2>&1 | tail -30
```

Expected: everything passes locally; the only skips are the `@pg_only` tests, `test_ci_provides_a_live_postgres` (skips off-CI by design), and any pre-existing `importorskip('discord')` skips. Any failure is a real regression — fix before proceeding.

- [ ] **Step 3: Run the `@pg_only` tier against a throwaway Postgres**

```bash
docker run --rm -d --name atl-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=atl_test -p 5433:5432 postgres:18-alpine
sleep 3
TEST_POSTGRES_URL=postgresql://postgres:test@localhost:5433/atl_test pytest \
  dashboard/backend/tests/test_agent_store_postgres.py \
  dashboard/backend/tests/test_strategy_store_postgres.py \
  dashboard/backend/tests/test_users_postgres.py -v
docker stop atl-pg-test
```

Expected: all `@pg_only` tests PASS, **none skipped**. If docker isn't available locally that's survivable — unlike in the original plan, this is no longer the only place the live tier runs (Task 2 put it in CI, and Step 5 below is the real gate). Local docker is the fast feedback loop, not the proof.

- [ ] **Step 4: Confirm the committed seed DB was not mutated**

```bash
git status --short dashboard/storage/data/backtest.db
```

Expected: no output (conftest isolates `DATABASE_PATH`; if the file shows as modified, a test imported a store before conftest ran — investigate, `git checkout -- dashboard/storage/data/backtest.db`, and fix before PR).

- [ ] **Step 5: Confirm the backend line is visible in a REAL uvicorn process**

`capsys` proves the factory emitted something; it does not prove prod will show it. Prove that against the real server, since the whole fail-visible mitigation rests on it:

```bash
PYTHONUNBUFFERED=1 timeout 10 ~/atl-venv/bin/python -m uvicorn dashboard.backend.app:app --port 8123 2>&1 | grep "backend:"
```

Expected: four `<store> backend: sqlite (ephemeral on Render)` lines (SQLite locally, since `CONTENT_DATABASE_URL` is unset). If nothing matches, someone converted a `print()` back into `logger.info()` and the mitigation is dead — a blocking regression, not a nit.

**`PYTHONUNBUFFERED=1` is load-bearing here — do not drop it.** The factory `print()`s run at import time; piped to `grep`, Python's stdout is *block*-buffered (a TTY would be line-buffered), so those four short lines sit in the buffer and `timeout`'s SIGTERM discards them before they flush — **zero matches on perfectly healthy code**, a false alarm indistinguishable from the regression above. (uvicorn's own "Application startup complete" still shows, because that is its logger writing to stderr — which is what makes the false alarm so convincing.) The env var forces an unbuffered flush, and it is *also* how prod shows these lines at all: `render.yaml` sets `PYTHONUNBUFFERED: true`, so this check reproduces the prod condition instead of a misleading local one. (This is a manual check, not a test: a pytest that reconfigures global logging to simulate uvicorn would corrupt the rest of the session.)

- [ ] **Step 6: Confirm CI is green *with the live tier actually running* — this is the gate**

```bash
git push
gh run list --branch feat/agent-db-persistence --limit 1
gh run view <run-id> --log | grep -E "pg_only|skipped|passed|failed" | tail -20
```

Expected: green, and the `@pg_only` tests **ran rather than skipped**. A green run in which they all skipped is a *failed* verification — it means the postgres service regressed and the Postgres backends are once again untested. `test_ci_provides_a_live_postgres` exists to make that loud, so check it passed rather than trusting the overall green.

- [ ] **Step 7: Leave the PR as a draft — do not mark it ready, do not merge**

The PR from Task 2 stays a draft with its `DO NOT MERGE until CONTENT_DATABASE_URL is set in the Render dashboard` first line intact. Marking it ready-for-review is a **human decision that follows setting the env var**, not a step this plan performs:

- This repo has no branch protection and open PRs get merged unreviewed (CLAUDE.md, "Merge & branch discipline"). A ready-for-review PR here is a merge-able PR.
- Merging with `CONTENT_DATABASE_URL` unset silently selects ephemeral SQLite: the feature ships, appears fine, and does nothing. Only *set-but-unreachable* fails loud.
- Report to the human: the branch is green, the live tier ran in CI, and the PR is held in draft pending the Render env var. Do not volunteer to set it, mark it ready, or merge.

---

## Deploy-time steps (NOT part of this branch — from the spec's Rollout section)

Recorded here so the PR body can reference them; they happen in the Render dashboard and GitHub, not in code. **This ordering is the whole reason the PR opens as a draft** (Task 2) and stays one (Task 9, Step 7) — a gate that lives only in a plan file is not a gate, which is precisely how PR #107 shipped.

1. Set `CONTENT_DATABASE_URL` in the **Render dashboard** (same Neon database as `USERS_DATABASE_URL`, pooled `-pooler` URL) — **before** merging.
2. Only now: drop the `DO NOT MERGE` line, mark the PR ready for review, and merge. CI auto-deploys on green main.
3. Confirm all four `... backend: postgres (<host>/<db>)` startup log lines in Render logs — and read the host/db, don't just grep for "postgres". A line naming the wrong database is the failure this format exists to expose.
4. Live verification: create an agent → trigger a redeploy → agent still lists and its API key still resolves.
5. Recreate the built-in agents once via the normal API; they persist thereafter.

If step 3 shows `sqlite (ephemeral on Render)`, the env var didn't take — the feature is inert and agents are still being lost. That is a rollback-or-fix-now signal, not a warning.

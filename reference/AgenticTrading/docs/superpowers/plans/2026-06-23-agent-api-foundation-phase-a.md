# Agent-facing API Foundation — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the committed v1 deliverable from the Plan 2 design spec — a typed, versioned, scoped `/api/v2` agent API (register → get_context → submit_decision → get_result) over the existing backtest engine, with a guaranteed `news_sentiment` slot, idempotent decisions, a uniform error model, per-agent rate limits, and benchmark/leaderboard hooks.

**Architecture:** Two new subpackages under `dashboard/backend/` — `api/v2/` (typed Pydantic contract + FastAPI routers) and `execution/` (an `ExecutionBackend` seam whose only v1 implementation, `BacktestBackend`, *wraps* the existing `ExternalBacktestSession` rather than rewriting it). A canonical `run_id` is minted at run creation and used for the whole lifecycle (in-memory session, every loop endpoint, the persisted DB row, the leaderboard). All schema parity is delivered; lifecycle parity is advertised via a `loop` field (`lockstep` now; `realtime` designed-for). Runs live in process memory (single-worker assumption, per spec §12).

**Tech Stack:** FastAPI, Pydantic v2, SQLite (self-migrating), pytest + `fastapi.testclient`. Flat top-level imports (backend root has **no** `__init__.py`; new subpackages `api/v2/` and `execution/` *do*). Tests prepend the backend dir to `sys.path`.

**Spec:** `docs/superpowers/specs/2026-06-23-agent-api-foundation-design.md` (Phase A = §11).

---

## File structure (what each new/edited file owns)

**New files**

- `dashboard/backend/api/v2/__init__.py` — package marker.
- `dashboard/backend/api/v2/models.py` — **the typed contract**: `ContextEnvelope`, `NewsSentimentEntry`, `DecisionRequest`, `ActionItem`, `SubmitAck`, `ResultEnvelope`, `RunManifest`, `ErrorEnvelope`, plus `SCHEMA_VERSION`, `UNIVERSE`, `ERROR_CODES`.
- `dashboard/backend/api/v2/errors.py` — `ApiError` exception + `api_error_handler` (uniform `{"error": {...}}` envelope, spec §5.4).
- `dashboard/backend/api/v2/router.py` — composes the v2 sub-routers under `/api/v2`.
- `dashboard/backend/api/v2/agents.py` — `register` / `me` / `rotate-key` (+ scopes).
- `dashboard/backend/api/v2/runs.py` — create · status · context · decisions · result · decisions-log · cancel (+ the in-memory run registry).
- `dashboard/backend/api/v2/schema.py` — `GET /api/v2/schema` (self-describing).
- `dashboard/backend/api/v2/leaderboard.py` — `GET /api/v2/leaderboard` (real v2 runs vs baselines).
- `dashboard/backend/auth_scopes.py` — scope constants + `require_scope()` dependency + `resolve_agent()`.
- `dashboard/backend/rate_limit.py` — per-agent token bucket + `enforce()`.
- `dashboard/backend/execution/__init__.py` — package marker.
- `dashboard/backend/execution/base.py` — `ExecutionBackend` interface (`loop: lockstep|realtime`).
- `dashboard/backend/execution/backtest_backend.py` — wraps `ExternalBacktestSession`; builds typed envelopes; news-sentiment loader (fail-closed).
- `dashboard/backend/execution/paper_backend.py` — designed-for **stub** (raises `NotImplementedError`).
- `dashboard/backend/tests/_v2_fakes.py` — `FakeBackend` (offline lifecycle driver for API + parity tests).
- `dashboard/backend/tests/test_v2_contracts.py`, `test_execution_backends.py`, `test_v2_auth.py`, `test_v2_runs.py`, `test_v2_idempotency.py`, `test_v2_parity.py`.
- `dashboard/examples/external_agent_client_v2.py` — reference client for the v2 contract.
- `docs/source/lab/agent_api.rst` — documented v2 surface.

**Edited files**

- `dashboard/backend/agent_store.py` — add `scopes` column (+ migration) and expose it on resolve/create.
- `dashboard/backend/database.py` — add `context_ref` column on `backtest_decisions`, an `idempotency_keys` table, a `run_manifest` table; matching insert/get methods. Update **both** `_init_schema` and `_migrate_schema`.
- `dashboard/backend/external_backtest_service.py` — surgical, back-compatible: optional `run_id` param on `ExternalBacktestSession`, a `context_ref_by_step` map threaded into the decision log, finalize uses the passed `run_id` when present.
- `dashboard/backend/app.py` — mount `api/v2` router and register `api_error_handler`.
- `dashboard/backend/api/router.py` — include the v2 router.
- `docs/source/lab/architecture.rst` — add a v2 row to the API surface table.

---

## Task 1: Agent scopes (agent_store)

Add a `scopes` column to `external_agents`, default = all five scopes, surfaced on every read. This is what `require_scope()` (Task 3) checks.

**Files:**
- Modify: `dashboard/backend/agent_store.py`
- Test: `dashboard/backend/tests/test_v2_auth.py` (scopes portion)

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_auth.py`:

```python
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent_store import AgentStore  # noqa: E402


def _store(tmp_path):
    return AgentStore(db_path=tmp_path / "agents.db")


def test_new_agent_has_default_scopes(tmp_path):
    store = _store(tmp_path)
    agent = store.create_agent(name="scoped-agent", session_id=str(uuid.uuid4()))
    assert set(agent["scopes"]) == {
        "agents:register", "runs:write", "context:read",
        "decisions:write", "runs:read",
    }


def test_resolve_api_key_returns_scopes(tmp_path):
    store = _store(tmp_path)
    created = store.create_agent(name="scoped-agent", session_id=str(uuid.uuid4()))
    resolved = store.resolve_api_key(created["api_key"])
    assert resolved is not None
    assert "decisions:write" in resolved["scopes"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_auth.py -v`
Expected: FAIL — `KeyError: 'scopes'` (column/field not present yet).

- [ ] **Step 3: Add the scopes column + surface it**

In `dashboard/backend/agent_store.py`, add the default constant near the top (after imports):

```python
DEFAULT_SCOPES = "agents:register,runs:write,context:read,decisions:write,runs:read"
```

In `_public_agent(...)`, add `scopes` to the returned dict (parse CSV → list):

```python
def _public_agent(row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Any]:
    data = dict(row)
    raw_scopes = data.get("scopes") or DEFAULT_SCOPES
    return {
        "agent_id": data["agent_id"],
        "name": data["name"],
        "session_id": data["session_id"],
        "model_name": data.get("model_name") or "local-model",
        "api_key_prefix": data.get("api_key_prefix") or "",
        "owner_user_id": data.get("owner_user_id"),
        "scopes": [s for s in str(raw_scopes).split(",") if s],
        "created_at": data.get("created_at"),
        "last_used_at": data.get("last_used_at"),
    }
```

In `_init_schema(...)`, add the column to the `CREATE TABLE external_agents` body (after `model_name`):

```python
                model_name TEXT NOT NULL DEFAULT 'local-model',
                scopes TEXT NOT NULL DEFAULT 'agents:register,runs:write,context:read,decisions:write,runs:read',
```

Then, still in `_init_schema(...)`, after the `CREATE TABLE` executes and before `conn.commit()`, add an idempotent migration for pre-existing DBs:

```python
        cursor.execute("PRAGMA table_info(external_agents)")
        cols = {row[1] for row in cursor.fetchall()}
        if "scopes" not in cols:
            cursor.execute(
                "ALTER TABLE external_agents ADD COLUMN scopes TEXT "
                "NOT NULL DEFAULT 'agents:register,runs:write,context:read,decisions:write,runs:read'"
            )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_auth.py -v`
Expected: PASS (both scope tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/agent_store.py dashboard/backend/tests/test_v2_auth.py
git commit -m "feat(v2): add scopes column to external_agents"
```

---

## Task 2: Database tables for v2 (context_ref, idempotency, manifest)

Add the three additive schema changes v2 needs. Self-migrating, per the repo rule (update both `_init_schema` and `_migrate_schema`).

**Files:**
- Modify: `dashboard/backend/database.py`
- Test: `dashboard/backend/tests/test_v2_db.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_db.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from database import BacktestDatabase  # noqa: E402


def _db(tmp_path):
    return BacktestDatabase(db_path=tmp_path / "v2.db")


def test_idempotency_roundtrip(tmp_path):
    db = _db(tmp_path)
    assert db.get_idempotency("run_x", 0, "key-1") is None
    ack = {"accepted": True, "next_step": 1}
    db.put_idempotency("run_x", 0, "key-1", ack)
    assert db.get_idempotency("run_x", 0, "key-1") == ack
    # Replay with same key returns the original, does not overwrite
    db.put_idempotency("run_x", 0, "key-1", {"accepted": False})
    assert db.get_idempotency("run_x", 0, "key-1") == ack


def test_run_manifest_roundtrip(tmp_path):
    db = _db(tmp_path)
    manifest = {"agent_name": "a", "model_name": "m", "mode": "backtest"}
    db.insert_run_manifest("run_y", manifest)
    assert db.get_run_manifest("run_y") == manifest
    assert db.get_run_manifest("missing") is None


def test_decisions_store_context_ref(tmp_path):
    db = _db(tmp_path)
    db.insert_decisions("run_z", [{
        "step_index": 0, "timestamp": "2026-04-15T10:30:00+00:00",
        "decision_source": "external_agent", "actions_submitted": [],
        "actions_executed": 0, "context_ref": "sha256:abc",
    }])
    rows = db.get_decisions("run_z")
    assert rows[0]["context_ref"] == "sha256:abc"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_db.py -v`
Expected: FAIL — `AttributeError: 'BacktestDatabase' object has no attribute 'get_idempotency'`.

- [ ] **Step 3: Add tables, migration, and methods**

In `dashboard/backend/database.py` `_init_schema(...)`, after the `backtest_decisions` index block and before `conn.commit()`, add the two new tables:

```python
        # idempotency_keys: replay-safe decision submissions (v2)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS idempotency_keys (
                run_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                idem_key TEXT NOT NULL,
                ack_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (run_id, idem_key)
            )
        """)

        # run_manifest: reproducibility manifest per v2 run (written at creation)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS run_manifest (
                run_id TEXT PRIMARY KEY,
                manifest_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
```

In `_ensure_decisions_table(...)`, add a `context_ref` column to the `CREATE TABLE` body (after `actions_executed`):

```python
                actions_executed INTEGER DEFAULT 0,
                context_ref TEXT,
```

Do the same in the duplicate `backtest_decisions` `CREATE TABLE` inside `_init_schema(...)` (keep the two definitions identical).

In `_migrate_schema(...)`, inside the main `try:` block (just before `self._ensure_decisions_table(cursor)`), add an idempotent column migration plus table creation for existing DBs:

```python
            cursor.execute("PRAGMA table_info(backtest_decisions)")
            dec_cols = {row[1] for row in cursor.fetchall()}
            if dec_cols and "context_ref" not in dec_cols:
                print("🔄 Migrating: Adding context_ref to backtest_decisions...")
                cursor.execute("ALTER TABLE backtest_decisions ADD COLUMN context_ref TEXT")
                conn.commit()
                print("✅ Added context_ref to backtest_decisions")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    run_id TEXT NOT NULL,
                    step_index INTEGER NOT NULL,
                    idem_key TEXT NOT NULL,
                    ack_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (run_id, idem_key)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS run_manifest (
                    run_id TEXT PRIMARY KEY,
                    manifest_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
```

Update `insert_decisions(...)` to persist `context_ref` (replace the `INSERT` + params):

```python
            cursor.execute("""
                INSERT INTO backtest_decisions
                (run_id, step_index, timestamp, decision_source, actions_submitted, actions_executed, context_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                run_id,
                entry.get("step_index", 0),
                entry.get("timestamp"),
                entry.get("decision_source"),
                json.dumps(entry.get("actions_submitted") or []),
                entry.get("actions_executed", 0),
                entry.get("context_ref"),
            ))
```

Update `get_decisions(...)` to select `context_ref` (replace the `SELECT`):

```python
        cursor.execute("""
            SELECT step_index, timestamp, decision_source, actions_submitted,
                   actions_executed, context_ref
            FROM backtest_decisions WHERE run_id = ?
            ORDER BY step_index ASC
        """, (run_id,))
```

Add the new methods (place them after `get_decisions`):

```python
    def put_idempotency(self, run_id: str, step_index: int,
                        idem_key: str, ack: Dict[str, Any]) -> None:
        """Store the ack for an idempotency key. INSERT OR IGNORE keeps the first write."""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR IGNORE INTO idempotency_keys
            (run_id, step_index, idem_key, ack_json)
            VALUES (?, ?, ?, ?)
        """, (run_id, step_index, idem_key, json.dumps(ack)))
        conn.commit()
        conn.close()

    def get_idempotency(self, run_id: str, step_index: int,
                        idem_key: str) -> Optional[Dict[str, Any]]:
        # Key scope is (run_id, idem_key), NOT the step: this realizes spec §5.2's
        # intent of safe retries past the step_already_closed race. step_index is
        # accepted for call symmetry with put_idempotency but excluded from the lookup.
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT ack_json FROM idempotency_keys
            WHERE run_id = ? AND idem_key = ?
        """, (run_id, idem_key))
        row = cursor.fetchone()
        conn.close()
        return json.loads(row["ack_json"]) if row else None

    def insert_run_manifest(self, run_id: str, manifest: Dict[str, Any]) -> None:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO run_manifest (run_id, manifest_json)
            VALUES (?, ?)
        """, (run_id, json.dumps(manifest)))
        conn.commit()
        conn.close()

    def get_run_manifest(self, run_id: str) -> Optional[Dict[str, Any]]:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT manifest_json FROM run_manifest WHERE run_id = ?", (run_id,))
        row = cursor.fetchone()
        conn.close()
        return json.loads(row["manifest_json"]) if row else None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_db.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/database.py dashboard/backend/tests/test_v2_db.py
git commit -m "feat(v2): add idempotency, run_manifest tables and context_ref column"
```

---

## Task 3: Error envelope + scope dependency

The uniform error envelope (spec §5.4) and the auth/scope gate (spec §6). Built together because the scope dependency raises `ApiError`.

**Files:**
- Create: `dashboard/backend/api/v2/__init__.py`, `dashboard/backend/api/v2/errors.py`, `dashboard/backend/auth_scopes.py`
- Test: `dashboard/backend/tests/test_v2_auth.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/backend/tests/test_v2_auth.py`:

```python
import pytest  # noqa: E402

from api.v2.errors import ApiError  # noqa: E402
from auth_scopes import SCOPES, parse_scopes, require_scope  # noqa: E402


def test_scopes_constant_is_the_five():
    assert SCOPES == [
        "agents:register", "runs:write", "context:read",
        "decisions:write", "runs:read",
    ]


def test_parse_scopes_splits_and_strips():
    assert parse_scopes("runs:read, decisions:write ") == ["runs:read", "decisions:write"]


def test_require_scope_rejects_missing_key():
    dep = require_scope("runs:read")
    with pytest.raises(ApiError) as exc:
        dep(x_api_key=None)
    assert exc.value.status == 401
    assert exc.value.code == "unauthorized"


def test_require_scope_rejects_bad_scope(tmp_path, monkeypatch):
    import agent_store as agent_store_mod
    store = AgentStore(db_path=tmp_path / "a.db")
    created = store.create_agent(name="limited", session_id=str(uuid.uuid4()))
    # Narrow the agent's scopes so the requested one is absent
    conn = store._get_connection()
    conn.execute("UPDATE external_agents SET scopes = ? WHERE agent_id = ?",
                 ("runs:read", created["agent_id"]))
    conn.commit()
    conn.close()
    monkeypatch.setattr(agent_store_mod, "agent_store", store)
    import auth_scopes
    monkeypatch.setattr(auth_scopes, "agent_store", store)

    dep = require_scope("decisions:write")
    with pytest.raises(ApiError) as exc:
        dep(x_api_key=created["api_key"])
    assert exc.value.status == 403
    assert exc.value.code == "forbidden_scope"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.v2'`.

- [ ] **Step 3: Create the package, errors, and scope dependency**

Create `dashboard/backend/api/v2/__init__.py`:

```python
"""Versioned agent API (v2) — typed, scoped, MCP-shaped surface."""
```

Create `dashboard/backend/api/v2/errors.py`:

```python
"""Uniform error envelope for /api/v2 (spec §5.4)."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

ERROR_CODES = [
    "validation_failed", "step_already_closed", "run_not_found",
    "unauthorized", "forbidden_scope", "rate_limited", "universe_violation",
    "insufficient_cash", "invalid_symbol", "invalid_status",
]


class ApiError(Exception):
    """Raised anywhere in v2; rendered as {"error": {...}} by api_error_handler."""

    def __init__(self, code: str, message: str, status: int = 400,
                 details: Optional[Dict[str, Any]] = None, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details
        self.retryable = retryable

    def to_envelope(self) -> Dict[str, Any]:
        return {"error": {
            "code": self.code,
            "message": self.message,
            "details": self.details,
            "retryable": self.retryable,
        }}


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    headers = {}
    if exc.code == "rate_limited" and exc.details and "retry_after" in exc.details:
        headers["Retry-After"] = str(exc.details["retry_after"])
    return JSONResponse(status_code=exc.status, content=exc.to_envelope(), headers=headers)
```

Create `dashboard/backend/auth_scopes.py`:

```python
"""Scope constants and the require_scope() FastAPI dependency (spec §6)."""

from __future__ import annotations

from typing import List, Optional

from fastapi import Header

from agent_store import agent_store
from api.v2.errors import ApiError

SCOPES: List[str] = [
    "agents:register", "runs:write", "context:read",
    "decisions:write", "runs:read",
]


def parse_scopes(csv: str) -> List[str]:
    return [s.strip() for s in (csv or "").split(",") if s.strip()]


def resolve_agent(x_api_key: Optional[str]) -> dict:
    """Resolve an X-API-Key to an agent record, or raise unauthorized."""
    agent = agent_store.resolve_api_key((x_api_key or "").strip())
    if not agent:
        raise ApiError("unauthorized", "Invalid or missing API key", status=401)
    return agent


def require_scope(scope: str):
    """FastAPI dependency factory: resolve caller and assert it holds `scope`."""

    def dependency(x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")) -> dict:
        agent = resolve_agent(x_api_key)
        if scope not in agent.get("scopes", []):
            raise ApiError(
                "forbidden_scope", f"Missing required scope: {scope}",
                status=403, details={"required": scope, "held": agent.get("scopes", [])},
            )
        return agent

    return dependency
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_auth.py -v`
Expected: PASS (all auth tests so far).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/v2/__init__.py dashboard/backend/api/v2/errors.py dashboard/backend/auth_scopes.py dashboard/backend/tests/test_v2_auth.py
git commit -m "feat(v2): add error envelope and require_scope dependency"
```

---

## Task 4: Per-agent rate limiter

Token bucket keyed on `agent_id` (spec §6). Env-configurable; raises `rate_limited` and sets `X-RateLimit-*` headers.

**Files:**
- Create: `dashboard/backend/rate_limit.py`
- Test: `dashboard/backend/tests/test_v2_auth.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/backend/tests/test_v2_auth.py`:

```python
from rate_limit import TokenBucketLimiter  # noqa: E402


def test_rate_limiter_allows_then_blocks():
    limiter = TokenBucketLimiter(per_minute=3, burst=3)
    results = [limiter.check("agent-1") for _ in range(4)]
    assert [r["allowed"] for r in results] == [True, True, True, False]
    assert results[-1]["remaining"] == 0
    assert results[-1]["retry_after"] >= 1


def test_rate_limiter_is_per_agent():
    limiter = TokenBucketLimiter(per_minute=1, burst=1)
    assert limiter.check("agent-a")["allowed"] is True
    assert limiter.check("agent-b")["allowed"] is True  # separate bucket
    assert limiter.check("agent-a")["allowed"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_auth.py::test_rate_limiter_allows_then_blocks -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'rate_limit'`.

- [ ] **Step 3: Implement the limiter**

Create `dashboard/backend/rate_limit.py`:

```python
"""Per-agent token-bucket rate limiting for /api/v2 (spec §6)."""

from __future__ import annotations

import math
import os
import threading
import time
from typing import Dict

from api.v2.errors import ApiError

RATE_PER_MINUTE = int(os.getenv("V2_RATE_LIMIT_PER_MINUTE", "120"))


class TokenBucketLimiter:
    """A token bucket per agent_id. Refills at per_minute/60 tokens per second."""

    def __init__(self, per_minute: int = RATE_PER_MINUTE, burst: int | None = None):
        self.per_minute = max(1, per_minute)
        self.burst = max(1, burst if burst is not None else per_minute)
        self.refill_per_sec = self.per_minute / 60.0
        self._buckets: Dict[str, tuple[float, float]] = {}  # agent_id -> (tokens, last_ts)
        self._lock = threading.Lock()

    def check(self, agent_id: str) -> Dict[str, object]:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(agent_id, (float(self.burst), now))
            tokens = min(self.burst, tokens + (now - last) * self.refill_per_sec)
            allowed = tokens >= 1.0
            if allowed:
                tokens -= 1.0
            self._buckets[agent_id] = (tokens, now)
        remaining = int(tokens)
        retry_after = 0 if allowed else int(math.ceil((1.0 - tokens) / self.refill_per_sec))
        return {
            "allowed": allowed,
            "limit": self.per_minute,
            "remaining": remaining,
            "reset": int(math.ceil((self.burst - tokens) / self.refill_per_sec)),
            "retry_after": retry_after,
        }


# Process-wide limiter shared by all v2 endpoints.
limiter = TokenBucketLimiter()


def enforce(agent_id: str, response) -> None:
    """Consume one token; set X-RateLimit-* headers; raise rate_limited on miss."""
    state = limiter.check(agent_id)
    response.headers["X-RateLimit-Limit"] = str(state["limit"])
    response.headers["X-RateLimit-Remaining"] = str(state["remaining"])
    response.headers["X-RateLimit-Reset"] = str(state["reset"])
    if not state["allowed"]:
        raise ApiError(
            "rate_limited", "Rate limit exceeded", status=429,
            details={"retry_after": state["retry_after"]}, retryable=True,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_auth.py -v`
Expected: PASS (all auth + rate-limit tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/rate_limit.py dashboard/backend/tests/test_v2_auth.py
git commit -m "feat(v2): add per-agent token-bucket rate limiter"
```

---

## Task 5: The typed contract (models.py)

The centerpiece — every wire shape as a Pydantic model (spec §5). Validating these is `test_v2_contracts.py`.

**Files:**
- Create: `dashboard/backend/api/v2/models.py`
- Test: `dashboard/backend/tests/test_v2_contracts.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_contracts.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from api.v2.models import (  # noqa: E402
    SCHEMA_VERSION, UNIVERSE, ActionItem, ContextEnvelope,
    DecisionRequest, ErrorEnvelope, NewsSentimentEntry, SubmitAck,
)


def test_schema_version_and_universe():
    assert SCHEMA_VERSION == "2.0"
    assert "AAPL" in UNIVERSE and len(UNIVERSE) == 30


def test_news_sentiment_entry_rejects_out_of_range_score():
    with pytest.raises(ValidationError):
        NewsSentimentEntry(sentiment="bullish", score=1.5, headline="x",
                           source="Reuters", url="http://x", age_hours=1.0, n_articles=1)


def test_action_item_rejects_off_universe_symbol():
    with pytest.raises(ValidationError):
        ActionItem(action="buy", symbol="ZZZ", confidence=0.5,
                   reasoning="valid reason", position_size=10)


def test_action_item_rejects_bad_confidence():
    with pytest.raises(ValidationError):
        ActionItem(action="buy", symbol="AAPL", confidence=2.0,
                   reasoning="valid reason", position_size=10)


def test_decision_request_requires_idempotency_key():
    with pytest.raises(ValidationError):
        DecisionRequest(actions=[])


def test_context_envelope_defaults_news_slot_present():
    env = ContextEnvelope(
        schema_version=SCHEMA_VERSION, run_id="run_1", mode="backtest",
        step_index=0, total_steps=10, loop="lockstep", status="loading",
        universe=UNIVERSE,
    )
    assert env.news_sentiment == {}
    assert env.news_overview is None


def test_submit_ack_minimal_valid():
    ack = SubmitAck(accepted=True, decision_source="external_agent",
                    status="waiting_decision", run_id="run_1")
    assert ack.executed == [] and ack.rejected == []


def test_error_envelope_shape():
    err = ErrorEnvelope.model_validate({"error": {
        "code": "validation_failed", "message": "bad", "retryable": False}})
    assert err.error.code == "validation_failed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_contracts.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.v2.models'`.

- [ ] **Step 3: Write models.py**

Create `dashboard/backend/api/v2/models.py`:

```python
"""Typed v2 wire contract (spec §5). Source of the auto-generated OpenAPI doc."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from llm_validator import DJIA_30

SCHEMA_VERSION = "2.0"
UNIVERSE_KEY = "djia_30"
UNIVERSE: List[str] = list(DJIA_30)
_UNIVERSE_SET = set(UNIVERSE)


# --- Context envelope ------------------------------------------------------

class NewsSentimentEntry(BaseModel):
    sentiment: str = Field(pattern="^(bullish|bearish|neutral)$")
    score: float = Field(ge=-1.0, le=1.0)
    headline: str
    source: str
    url: str
    age_hours: float = Field(ge=0.0)
    n_articles: int = Field(ge=0)


class PortfolioState(BaseModel):
    cash: float
    positions_value: float
    total_equity: float
    num_positions: int


class HoldingItem(BaseModel):
    shares: float
    entry_price: float
    current_price: float
    position_value: float
    pnl_pct: float


class SignalItem(BaseModel):
    price: float
    rsi: float
    macd: float
    macd_signal: float
    sma20: float
    sma50: float
    bb_upper: float
    bb_lower: float


class ContextEnvelope(BaseModel):
    schema_version: str
    run_id: str
    mode: str
    step_index: int
    total_steps: int
    timestamp: Optional[str] = None
    loop: str  # "lockstep" | "realtime"
    decision_deadline_at: Optional[str] = None
    decision_timeout_seconds: Optional[int] = None
    status: str  # loading | waiting_decision | completed | closed | failed
    universe: List[str]
    portfolio: Optional[PortfolioState] = None
    current_holdings: Dict[str, HoldingItem] = Field(default_factory=dict)
    recent_trades: List[Dict[str, Any]] = Field(default_factory=list)
    top_signals: Dict[str, SignalItem] = Field(default_factory=dict)
    news_sentiment: Dict[str, NewsSentimentEntry] = Field(default_factory=dict)
    news_overview: Optional[str] = None
    decision_format: Optional[Dict[str, Any]] = None


# --- Decision request ------------------------------------------------------

class ActionItem(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    action: str = Field(pattern="^(buy|sell|hold)$")
    symbol: str
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str = Field(min_length=5, max_length=500)
    position_size: int = Field(ge=0, le=10000)
    stop_loss_price: Optional[float] = Field(default=None, gt=0)
    take_profit_price: Optional[float] = Field(default=None, gt=0)

    @field_validator("symbol")
    @classmethod
    def _symbol_in_universe(cls, v: str) -> str:
        if v not in _UNIVERSE_SET:
            raise ValueError(f"universe_violation: {v} not in DJIA-30")
        return v


class DecisionRequest(BaseModel):
    idempotency_key: str = Field(min_length=1)
    actions: List[ActionItem]


# --- Submit ack ------------------------------------------------------------

class ExecutedItem(BaseModel):
    action: str
    symbol: str
    shares: float
    price: Optional[float] = None


class RejectedItem(BaseModel):
    symbol: str
    reason: str


class SubmitAck(BaseModel):
    accepted: bool
    executed: List[ExecutedItem] = Field(default_factory=list)
    rejected: List[RejectedItem] = Field(default_factory=list)
    decision_source: str  # external_agent | timeout_hold | validation_hold
    next_step: Optional[int] = None
    status: str
    run_id: str
    metrics: Optional[Dict[str, Any]] = None


# --- Result ----------------------------------------------------------------

class RunManifest(BaseModel):
    agent_name: str
    model_name: str
    mode: str
    universe: str = UNIVERSE_KEY
    start_date: str
    end_date: str
    decision_timeout_seconds: int
    schema_version: str = SCHEMA_VERSION
    news_sentiment_source: Optional[str] = None


class ResultEnvelope(BaseModel):
    run: Dict[str, Any]
    equity_curve: List[Dict[str, Any]] = Field(default_factory=list)
    trades: List[Dict[str, Any]] = Field(default_factory=list)
    decisions: List[Dict[str, Any]] = Field(default_factory=list)
    metrics: Dict[str, Any] = Field(default_factory=dict)
    manifest: Optional[RunManifest] = None


# --- Error -----------------------------------------------------------------

class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None
    retryable: bool = False


class ErrorEnvelope(BaseModel):
    error: ErrorDetail
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_contracts.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/v2/models.py dashboard/backend/tests/test_v2_contracts.py
git commit -m "feat(v2): add typed wire contract (models.py)"
```

---

## Task 6: ExecutionBackend interface + paper stub

The parity seam (spec §4.2). The interface plus a designed-for paper stub that raises `NotImplementedError`.

**Files:**
- Create: `dashboard/backend/execution/__init__.py`, `dashboard/backend/execution/base.py`, `dashboard/backend/execution/paper_backend.py`
- Test: `dashboard/backend/tests/test_execution_backends.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_execution_backends.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest  # noqa: E402

from execution.base import ExecutionBackend  # noqa: E402
from execution.paper_backend import PaperBackend  # noqa: E402


def test_execution_backend_is_abstract():
    with pytest.raises(TypeError):
        ExecutionBackend()  # abstract — cannot instantiate


def test_paper_backend_is_designed_for_stub():
    backend = PaperBackend()
    assert backend.loop == "realtime"
    with pytest.raises(NotImplementedError):
        backend.build_context()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_execution_backends.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'execution'`.

- [ ] **Step 3: Create the package, interface, and stub**

Create `dashboard/backend/execution/__init__.py`:

```python
"""Execution backends — the mode-parity seam (spec §4.2)."""
```

Create `dashboard/backend/execution/base.py`:

```python
"""ExecutionBackend interface. Schema parity is universal; lifecycle parity is per-loop."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class ExecutionBackend(ABC):
    """One run's execution. `loop` advertises lifecycle parity: lockstep | realtime."""

    loop: str = "lockstep"

    @abstractmethod
    def build_context(self) -> Dict[str, Any]:
        """Return a ContextEnvelope-shaped dict for the current step."""

    @abstractmethod
    def apply_decisions(self, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Validate + execute actions; return a SubmitAck-shaped dict."""

    @abstractmethod
    def status(self) -> Dict[str, Any]:
        """Return a run-status dict."""

    @abstractmethod
    def result(self) -> Optional[Dict[str, Any]]:
        """Return a ResultEnvelope-shaped dict, or None if not finalized."""

    def advance(self) -> None:
        """Lockstep stepping hook. Realtime backends are wall-clock driven (no-op)."""
        return None

    def cancel(self) -> None:
        """Best-effort cancel → closed."""
        return None
```

Create `dashboard/backend/execution/paper_backend.py`:

```python
"""PaperBackend — DESIGNED-FOR STUB (spec §4.2, Phase B).

Paper trading has no execution path in the codebase today: AlpacaPaperTradingClient
is read-only and there is no order-submission or step loop. Building this means real
new code (live order submission, a realtime decision-cadence scheduler, live bar
assembly) and needs its own design pass. This stub exists so the parity seam is real
and the eventual drop-in is mechanical.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from execution.base import ExecutionBackend

_NOT_BUILT = "PaperBackend is a designed-for stub (Phase B); not built in v1."


class PaperBackend(ExecutionBackend):
    loop = "realtime"

    def build_context(self) -> Dict[str, Any]:
        raise NotImplementedError(_NOT_BUILT)

    def apply_decisions(self, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
        raise NotImplementedError(_NOT_BUILT)

    def status(self) -> Dict[str, Any]:
        raise NotImplementedError(_NOT_BUILT)

    def result(self) -> Optional[Dict[str, Any]]:
        raise NotImplementedError(_NOT_BUILT)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_execution_backends.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/execution/__init__.py dashboard/backend/execution/base.py dashboard/backend/execution/paper_backend.py dashboard/backend/tests/test_execution_backends.py
git commit -m "feat(v2): add ExecutionBackend interface and paper stub"
```

---

## Task 7: Surgical engine edits (canonical run_id + context_ref hook)

Make `ExternalBacktestSession` accept a caller-supplied `run_id` and thread a per-step `context_ref` into its decision log — both back-compatible (v1 callers pass neither and behave exactly as before).

**Files:**
- Modify: `dashboard/backend/external_backtest_service.py`
- Test: `dashboard/backend/tests/test_external_session_compat.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_external_session_compat.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from external_backtest_service import ExternalBacktestSession  # noqa: E402


def _session(**kw):
    defaults = dict(backtest_id="bt_x", session_id="sess_x", agent_name="a",
                    model_name="m", start_date="2026-04-15", end_date="2026-04-16")
    defaults.update(kw)
    return ExternalBacktestSession(**defaults)


def test_run_id_defaults_to_none_like_v1():
    s = _session()
    assert s.run_id is None
    assert s.context_ref_by_step == {}


def test_run_id_can_be_supplied():
    s = _session(run_id="run_canonical_1")
    assert s.run_id == "run_canonical_1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_external_session_compat.py -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'run_id'`.

- [ ] **Step 3: Apply the three surgical edits**

In `dashboard/backend/external_backtest_service.py`, add `run_id` to the `__init__` signature (after `mode`):

```python
        mode: str = "safe_trading",
        run_id: Optional[str] = None,
    ):
```

In `__init__`, change the `self.run_id` initialization and add the context-ref map. Replace:

```python
        self.run_id: Optional[str] = None
        self.baseline_run_ids: Dict[str, str] = {}
```

with:

```python
        self.run_id: Optional[str] = run_id
        self.baseline_run_ids: Dict[str, str] = {}
        # v2 backends record the hash of the exact context served per step here;
        # threaded into the decision log so each decision traces to its context.
        self.context_ref_by_step: Dict[int, str] = {}
```

In `_advance_step(...)`, add `context_ref` to the appended decision-log entry. Replace:

```python
        self.decision_log.append({
            "step_index": self.step_index,
            "timestamp": timestamp.isoformat()
            if hasattr(timestamp, "isoformat")
            else str(timestamp),
            "decision_source": decision_source,
            "actions_submitted": raw_actions or [],
            "actions_executed": len(executable),
        })
```

with:

```python
        self.decision_log.append({
            "step_index": self.step_index,
            "timestamp": timestamp.isoformat()
            if hasattr(timestamp, "isoformat")
            else str(timestamp),
            "decision_source": decision_source,
            "actions_submitted": raw_actions or [],
            "actions_executed": len(executable),
            "context_ref": self.context_ref_by_step.get(self.step_index),
        })
```

In `_finalize(...)`, use the supplied `run_id` when present. Replace:

```python
        self.run_id = f"ext_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
```

with:

```python
        if not self.run_id:
            self.run_id = f"ext_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
```

- [ ] **Step 4: Run test to verify it passes (and v1 unaffected)**

Run: `cd dashboard/backend && pytest tests/test_external_session_compat.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/external_backtest_service.py dashboard/backend/tests/test_external_session_compat.py
git commit -m "feat(v2): thread canonical run_id and context_ref through the engine (back-compat)"
```

---

## Task 8: BacktestBackend (wraps the engine)

The only v1 `ExecutionBackend`. Produces typed envelopes from the existing `ExternalBacktestSession`, guarantees the `news_sentiment` slot (fail-closed), computes per-step `context_ref`, does per-action partial validation, and assembles the result manifest.

**Files:**
- Create: `dashboard/backend/execution/backtest_backend.py`
- Test: `dashboard/backend/tests/test_execution_backends.py` (extend, offline via a synthetic loader)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/backend/tests/test_execution_backends.py`:

```python
import pandas as pd  # noqa: E402

import execution.backtest_backend as bb_mod  # noqa: E402
from execution.backtest_backend import BacktestBackend, load_news_sentiment  # noqa: E402
from api.v2.models import ContextEnvelope, SubmitAck  # noqa: E402


def test_news_sentiment_fail_closed_when_plan1_absent(monkeypatch):
    # No integrations.news_sentiment module → slot present, empty, overview None.
    sentiment, overview = load_news_sentiment(["AAPL"], "2026-04-15T10:30:00+00:00")
    assert sentiment == {} and overview is None


def _synthetic_bars(symbols, periods=40):
    idx = pd.date_range("2026-04-15 13:30", periods=periods, freq="h", tz="UTC")
    data = {}
    for i, sym in enumerate(symbols):
        base = 100 + i * 10
        df = pd.DataFrame({
            "open": base, "high": base + 1, "low": base - 1,
            "close": [base + (j % 5) for j in range(periods)],
            "volume": 1000,
        }, index=idx)
        data[sym] = df
    return data


def test_backtest_backend_emits_typed_context(monkeypatch):
    symbols = ["AAPL", "MSFT", "JPM"]

    class _Loader:
        def fetch_bars(self, syms, start, end):
            return _synthetic_bars(symbols)

    monkeypatch.setattr(bb_mod.bha, "AlpacaDataLoader", lambda: _Loader())
    monkeypatch.setattr(bb_mod, "DJIA_30", symbols, raising=False)

    backend = BacktestBackend(
        run_id="run_test_1", session_id="sess_1", agent_name="a",
        model_name="m", start_date="2026-04-15", end_date="2026-04-16",
    )
    backend.load_blocking()  # synchronous load for the test
    assert backend.loop == "lockstep"

    ctx = backend.build_context()
    # Slot guaranteed and the whole envelope validates against the typed model.
    assert "news_sentiment" in ctx
    ContextEnvelope.model_validate(ctx)

    ack = backend.apply_decisions([
        {"action": "hold", "symbol": "AAPL", "confidence": 0.4,
         "reasoning": "hold steady", "position_size": 0},
    ])
    SubmitAck.model_validate(ack)
    assert ack["accepted"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_execution_backends.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'execution.backtest_backend'`.

- [ ] **Step 3: Implement BacktestBackend**

Create `dashboard/backend/execution/backtest_backend.py`:

```python
"""BacktestBackend — wraps ExternalBacktestSession behind the ExecutionBackend seam.

Schema parity: build_context/apply_decisions/result emit the typed v2 shapes.
Lifecycle parity: loop == "lockstep" (decision_deadline_at + auto-hold apply).
"""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any, Dict, List, Optional, Tuple

from pydantic import ValidationError

from api.v2.models import SCHEMA_VERSION, UNIVERSE_KEY, ActionItem
from database import db
from execution.base import ExecutionBackend
from llm_validator import DJIA_30
import external_backtest_service as ext

# Re-export so tests can monkeypatch the loader / universe on this module.
bha = ext.bha


def load_news_sentiment(universe: List[str], timestamp: Any) -> Tuple[Dict[str, Any], Optional[str]]:
    """Populate the news_sentiment slot from Plan 1's adapter, fail-closed.

    Plan 1 (integrations/news_sentiment.py) is expected to expose
    get_news_sentiment(universe, timestamp) -> {"news_sentiment": {...}, "news_overview": str|None}.
    Until it lands, the slot is guaranteed present and empty.
    """
    try:
        from integrations.news_sentiment import get_news_sentiment  # type: ignore
    except Exception:
        return {}, None
    try:
        data = get_news_sentiment(universe, timestamp) or {}
        return data.get("news_sentiment", {}) or {}, data.get("news_overview")
    except Exception:
        return {}, None


def _context_hash(envelope: Dict[str, Any]) -> str:
    payload = json.dumps(envelope, sort_keys=True, default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


class BacktestBackend(ExecutionBackend):
    loop = "lockstep"

    def __init__(self, *, run_id: str, session_id: str, agent_name: str,
                 model_name: str, start_date: str, end_date: str,
                 mode: str = "safe_trading"):
        self.run_id = run_id
        self.session = ext.ExternalBacktestSession(
            backtest_id=run_id, session_id=session_id, agent_name=agent_name,
            model_name=model_name, start_date=start_date, end_date=end_date,
            mode=mode, run_id=run_id,
        )
        self.news_sentiment_source: Optional[str] = None

    # -- lifecycle ---------------------------------------------------------

    def load_blocking(self) -> None:
        self.session.load_market_data()

    def start_background_load(self) -> None:
        def _load() -> None:
            try:
                self.session.load_market_data()
            except Exception as exc:  # mirror v1 start_backtest behavior
                self.session.status = "failed"
                self.session.error = str(exc)

        self.session.status = "loading"
        threading.Thread(target=_load, daemon=True).start()

    def current_step_index(self) -> int:
        return self.session.step_index

    # -- context -----------------------------------------------------------

    def build_context(self) -> Dict[str, Any]:
        step = self.session.get_current_step()
        status = step.get("status")
        base: Dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "run_id": self.run_id,
            "mode": "backtest",
            "loop": self.loop,
            "universe": list(DJIA_30),
            "status": status,
            "step_index": self.session.step_index,
            "total_steps": self.session.total_steps,
            "news_sentiment": {},
            "news_overview": None,
        }
        if status != "waiting_decision":
            return base

        snap = step["market_snapshot"]
        sentiment, overview = load_news_sentiment(list(DJIA_30), step.get("timestamp"))
        envelope = {
            **base,
            "step_index": step["step_index"],
            "total_steps": step["total_steps"],
            "timestamp": step["timestamp"],
            "decision_deadline_at": step["decision_deadline_at"],
            "decision_timeout_seconds": step["decision_timeout_seconds"],
            "portfolio": snap["portfolio"],
            "current_holdings": snap["current_holdings"],
            "recent_trades": snap["recent_trades"],
            "top_signals": snap["top_signals"],
            "news_sentiment": sentiment,
            "news_overview": overview,
            "decision_format": step["decision_format"],
        }
        # Record the hash of exactly what we served, keyed by step, for the decision log.
        self.session.context_ref_by_step[step["step_index"]] = _context_hash(envelope)
        return envelope

    # -- decisions ---------------------------------------------------------

    def apply_decisions(self, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
        valid: List[Dict[str, Any]] = []
        rejected: List[Dict[str, str]] = []
        for raw in actions:
            try:
                item = ActionItem(**raw)
                valid.append(item.model_dump())
            except ValidationError as exc:
                msg = exc.errors()[0].get("msg", "validation_failed")
                reason = "universe_violation" if "universe_violation" in msg else "validation_failed"
                rejected.append({"symbol": str(raw.get("symbol", "?")), "reason": reason})

        result = self.session.submit_decisions({"actions": valid})

        executed = [
            {"action": e.get("action"), "symbol": e.get("symbol"),
             "shares": e.get("shares"), "price": None}
            for e in (result.get("executed") or [])
        ]
        decision_source = result.get("decision_source") or "external_agent"
        if not valid and rejected:
            decision_source = "validation_hold"

        return {
            "accepted": bool(result.get("accepted", False)) or bool(executed) or not rejected,
            "executed": executed,
            "rejected": rejected,
            "decision_source": decision_source,
            "next_step": result.get("next_step", self.session.step_index),
            "status": result.get("status", self.session.status),
            "run_id": self.run_id,
            "metrics": result.get("metrics"),
        }

    def advance(self) -> None:
        # Lockstep engine advances inside submit; this only applies a pending timeout.
        self.session.get_current_step()

    def cancel(self) -> None:
        self.session.status = "closed"

    # -- status / result ---------------------------------------------------

    def status(self) -> Dict[str, Any]:
        s = self.session.get_status()
        s["mode"] = "backtest"
        s["loop"] = self.loop
        return s

    def result(self) -> Optional[Dict[str, Any]]:
        if not self.session.run_id:
            return None
        base = ext.get_run_result(self.session.run_id, self.session.session_id)
        if base is None:
            return None
        base["manifest"] = db.get_run_manifest(self.run_id)
        return base
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_execution_backends.py -v`
Expected: PASS (4 tests). The synthetic-bars test drives a real `ExternalBacktestSession` offline.

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/execution/backtest_backend.py dashboard/backend/tests/test_execution_backends.py
git commit -m "feat(v2): add BacktestBackend wrapping the existing engine"
```

---

## Task 9: Offline FakeBackend test helper

A scripted `ExecutionBackend` that drives the full lifecycle with zero Alpaca/network — used by the API, idempotency, and parity tests so they stay deterministic and offline.

**Files:**
- Create: `dashboard/backend/tests/_v2_fakes.py`
- Test: `dashboard/backend/tests/test_v2_parity.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_parity.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from api.v2.models import ContextEnvelope, ResultEnvelope, SubmitAck  # noqa: E402
from tests._v2_fakes import FakeBackend  # noqa: E402


def test_fake_backend_envelopes_validate_against_models():
    """Schema parity: a non-backtest backend's envelopes pass the same models."""
    backend = FakeBackend(run_id="run_fake_1")
    ctx = backend.build_context()
    ContextEnvelope.model_validate(ctx)

    ack = backend.apply_decisions([
        {"action": "buy", "symbol": "AAPL", "confidence": 0.8,
         "reasoning": "momentum looks strong", "position_size": 5},
    ])
    SubmitAck.model_validate(ack)

    # Drive to completion, then the result validates too.
    while backend.status()["status"] != "completed":
        backend.apply_decisions([])
    ResultEnvelope.model_validate(backend.result())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_parity.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tests._v2_fakes'`.

- [ ] **Step 3: Implement FakeBackend**

Create `dashboard/backend/tests/_v2_fakes.py`:

```python
"""Offline ExecutionBackend for deterministic v2 tests (no Alpaca, no network)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from api.v2.models import SCHEMA_VERSION, UNIVERSE
from execution.base import ExecutionBackend


class FakeBackend(ExecutionBackend):
    loop = "lockstep"

    def __init__(self, run_id: str = "run_fake", total_steps: int = 2,
                 session_id: str = "sess_fake"):
        self.run_id = run_id
        self.session_id = session_id
        self.total_steps = total_steps
        self.step_index = 0
        self._status = "waiting_decision"
        self._executed_log: List[Dict[str, Any]] = []

    def current_step_index(self) -> int:
        return self.step_index

    def build_context(self) -> Dict[str, Any]:
        if self._status == "completed":
            return {
                "schema_version": SCHEMA_VERSION, "run_id": self.run_id,
                "mode": "backtest", "loop": self.loop, "status": "completed",
                "step_index": self.step_index, "total_steps": self.total_steps,
                "universe": list(UNIVERSE), "news_sentiment": {}, "news_overview": None,
            }
        return {
            "schema_version": SCHEMA_VERSION, "run_id": self.run_id, "mode": "backtest",
            "loop": self.loop, "status": "waiting_decision",
            "step_index": self.step_index, "total_steps": self.total_steps,
            "timestamp": "2026-04-15T13:30:00+00:00",
            "decision_deadline_at": "2026-04-15T13:30:30+00:00",
            "decision_timeout_seconds": 30, "universe": list(UNIVERSE),
            "portfolio": {"cash": 100000.0, "positions_value": 0.0,
                          "total_equity": 100000.0, "num_positions": 0},
            "current_holdings": {}, "recent_trades": [], "top_signals": {},
            "news_sentiment": {}, "news_overview": None,
            "decision_format": {"actions": []},
        }

    def apply_decisions(self, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
        executed = [{"action": a.get("action"), "symbol": a.get("symbol"),
                     "shares": a.get("position_size", 0), "price": 100.0}
                    for a in actions if a.get("action") in ("buy", "sell")]
        self._executed_log.extend(executed)
        self.step_index += 1
        if self.step_index >= self.total_steps:
            self._status = "completed"
        return {
            "accepted": True, "executed": executed, "rejected": [],
            "decision_source": "external_agent", "next_step": self.step_index,
            "status": self._status, "run_id": self.run_id,
            "metrics": self._metrics() if self._status == "completed" else None,
        }

    def status(self) -> Dict[str, Any]:
        return {"run_id": self.run_id, "status": self._status,
                "step_index": self.step_index, "total_steps": self.total_steps,
                "mode": "backtest", "loop": self.loop}

    def _metrics(self) -> Dict[str, Any]:
        return {"total_return": 0.0, "sharpe_ratio": 0.0, "max_drawdown": 0.0,
                "num_trades": len(self._executed_log), "final_equity": 100000.0,
                "llm_calls": self.total_steps, "input_tokens": 0,
                "output_tokens": 0, "est_cost_usd": 0.0}

    def result(self) -> Optional[Dict[str, Any]]:
        if self._status != "completed":
            return None
        return {
            "run": {"run_id": self.run_id, "agent_name": "fake", "mode": "backtest"},
            "equity_curve": [{"timestamp": "2026-04-15T13:30:00+00:00", "equity": 100000.0,
                              "cash": 100000.0, "positions_value": 0.0}],
            "trades": [], "decisions": [], "metrics": self._metrics(),
            "manifest": {"agent_name": "fake", "model_name": "m", "mode": "backtest",
                         "universe": "djia_30", "start_date": "2026-04-15",
                         "end_date": "2026-04-16", "decision_timeout_seconds": 30,
                         "schema_version": SCHEMA_VERSION, "news_sentiment_source": None},
        }

    def cancel(self) -> None:
        self._status = "closed"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_parity.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/tests/_v2_fakes.py dashboard/backend/tests/test_v2_parity.py
git commit -m "test(v2): add offline FakeBackend and schema-parity test"
```

---

## Task 10: v2 agents router (register / me / rotate-key)

The `register` verb plus identity resolution and key rotation (spec §4.1, §6).

**Files:**
- Create: `dashboard/backend/api/v2/agents.py`
- Test: `dashboard/backend/tests/test_v2_agents_router.py` (route-shape only; the live HTTP tests land in Task 14 once the router is mounted)

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_agents_router.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def test_agents_router_exposes_the_three_routes():
    from api.v2.agents import router
    paths = sorted(r.path for r in router.routes)
    assert paths == [
        "/v2/agents",
        "/v2/agents/me",
        "/v2/agents/{agent_id}/rotate-key",
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_agents_router.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.v2.agents'`.

- [ ] **Step 3: Implement the agents router**

Create `dashboard/backend/api/v2/agents.py`:

```python
"""v2 agents: register / me / rotate-key (spec §4.1, §6)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, Field

from agent_store import agent_store
from api.v2.errors import ApiError
from auth_scopes import resolve_agent, require_scope

router = APIRouter(prefix="/v2/agents", tags=["v2-agents"])


class RegisterAgentBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    model_name: str = Field(default="local-model", max_length=100)


def _public(agent: dict) -> dict:
    return {
        "agent_id": agent["agent_id"],
        "name": agent["name"],
        "session_id": agent["session_id"],
        "model_name": agent["model_name"],
        "scopes": agent.get("scopes", []),
    }


@router.post("")
async def register(body: RegisterAgentBody, request: Request):
    """register → create an agent, return api_key (shown once), session_id, scopes."""
    browser = request.headers.get("x-session-id") or request.headers.get("X-Session-Id")
    agent = agent_store.create_agent(
        name=body.name.strip(),
        model_name=body.model_name.strip() or "local-model",
        owner_browser_session=browser.strip() if browser else None,
    )
    out = _public(agent)
    out["api_key"] = agent["api_key"]
    return out


@router.get("/me")
async def me(x_api_key: Optional[str] = Header(default=None, alias="X-API-Key")):
    """Resolve the caller from X-API-Key → identity + scopes."""
    agent = resolve_agent(x_api_key)
    return _public(agent)


@router.post("/{agent_id}/rotate-key")
async def rotate_key(agent_id: str, agent: dict = Depends(require_scope("agents:register"))):
    """Rotate the caller's own key. The previous key stops working immediately."""
    if agent["agent_id"] != agent_id:
        raise ApiError("forbidden_scope", "Can only rotate your own key", status=403)
    new_key = agent_store.rotate_api_key(agent_id)
    if not new_key:
        raise ApiError("run_not_found", "Agent not found", status=404)
    return {"agent_id": agent_id, "api_key": new_key}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_agents_router.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/v2/agents.py dashboard/backend/tests/test_v2_agents_router.py
git commit -m "feat(v2): add agents router (register/me/rotate-key)"
```

---

## Task 11: v2 runs router + registry (create/context/decisions/result/cancel)

The four canonical loop verbs plus status/decisions-log/cancel, the in-memory run registry, the canonical `run_id`, idempotent decisions, and the manifest write (spec §4.1–4.3, §5, §8).

**Files:**
- Create: `dashboard/backend/api/v2/runs.py`
- Test: `dashboard/backend/tests/test_v2_runs.py`, `dashboard/backend/tests/test_v2_idempotency.py`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/backend/tests/test_v2_runs.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import api.v2.runs as runs_mod  # noqa: E402
from tests._v2_fakes import FakeBackend  # noqa: E402


def _register_fake(run_id="run_unit_1", session_id="sess_unit_1"):
    backend = FakeBackend(run_id=run_id, session_id=session_id)
    runs_mod.register_run(run_id, backend, session_id)
    return backend


def test_lifecycle_create_context_decide_result():
    backend = _register_fake()
    # context
    ctx = runs_mod._context_for("run_unit_1", "sess_unit_1")
    assert ctx["status"] == "waiting_decision"
    # decide twice → completes (FakeBackend has 2 steps)
    runs_mod._submit_for("run_unit_1", "sess_unit_1", "key-a", [
        {"action": "buy", "symbol": "AAPL", "confidence": 0.8,
         "reasoning": "momentum strong", "position_size": 5}])
    ack = runs_mod._submit_for("run_unit_1", "sess_unit_1", "key-b", [])
    assert ack["status"] == "completed"
    # result
    res = runs_mod._result_for("run_unit_1", "sess_unit_1")
    assert res["manifest"]["universe"] == "djia_30"


def test_wrong_session_cannot_read_run():
    _register_fake(run_id="run_unit_2", session_id="owner")
    import pytest
    from api.v2.errors import ApiError
    with pytest.raises(ApiError) as exc:
        runs_mod._context_for("run_unit_2", "intruder")
    assert exc.value.status in (403, 404)
```

Create `dashboard/backend/tests/test_v2_idempotency.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import api.v2.runs as runs_mod  # noqa: E402
from tests._v2_fakes import FakeBackend  # noqa: E402


def test_replayed_key_returns_original_ack_no_double_execute():
    backend = FakeBackend(run_id="run_idem_1", session_id="sess_idem", total_steps=5)
    runs_mod.register_run("run_idem_1", backend, "sess_idem")

    first = runs_mod._submit_for("run_idem_1", "sess_idem", "same-key", [
        {"action": "buy", "symbol": "AAPL", "confidence": 0.8,
         "reasoning": "first submit", "position_size": 5}])
    step_after_first = backend.step_index

    replay = runs_mod._submit_for("run_idem_1", "sess_idem", "same-key", [
        {"action": "buy", "symbol": "MSFT", "confidence": 0.9,
         "reasoning": "should be ignored", "position_size": 9}])

    assert replay == first                 # original ack returned verbatim
    assert backend.step_index == step_after_first  # no second advance
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard/backend && pytest tests/test_v2_runs.py tests/test_v2_idempotency.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.v2.runs'`.

- [ ] **Step 3: Implement the runs router + registry**

Create `dashboard/backend/api/v2/runs.py`:

```python
"""v2 runs: create · status · context · decisions · result · decisions-log · cancel.

One canonical run_id (minted here) drives the whole lifecycle (spec §4.3). Runs live
in process memory (single-worker assumption, spec §12).
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel, Field

import external_backtest_service as ext
from api.v2.errors import ApiError
from api.v2.models import DecisionRequest, RunManifest, SCHEMA_VERSION, UNIVERSE_KEY
from auth_scopes import require_scope
from database import db
from execution.backtest_backend import BacktestBackend
from rate_limit import enforce

router = APIRouter(prefix="/v2/runs", tags=["v2-runs"])

# run_id -> {"backend": ExecutionBackend, "session_id": str}
_runs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()


def _mint_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"run_{stamp}_{uuid.uuid4().hex[:8]}"


def register_run(run_id: str, backend: Any, session_id: str) -> None:
    """Register a backend under a run_id (used by create + tests)."""
    with _lock:
        _runs[run_id] = {"backend": backend, "session_id": session_id}


def _require_run(run_id: str, session_id: str) -> Any:
    with _lock:
        entry = _runs.get(run_id)
    if not entry:
        raise ApiError("run_not_found", f"Run {run_id} not found", status=404)
    if entry["session_id"] != session_id:
        raise ApiError("run_not_found", "Run not found in your session", status=404)
    return entry["backend"]


# -- pure helpers (unit-testable without HTTP) -----------------------------

def _context_for(run_id: str, session_id: str) -> Dict[str, Any]:
    backend = _require_run(run_id, session_id)
    return backend.build_context()


def _submit_for(run_id: str, session_id: str, idem_key: str,
                actions: List[Dict[str, Any]]) -> Dict[str, Any]:
    backend = _require_run(run_id, session_id)
    step = backend.current_step_index()
    existing = db.get_idempotency(run_id, step, idem_key)
    if existing is not None:
        return existing
    ack = backend.apply_decisions(actions)
    db.put_idempotency(run_id, step, idem_key, ack)
    return ack


def _result_for(run_id: str, session_id: str) -> Dict[str, Any]:
    backend = _require_run(run_id, session_id)
    res = backend.result()
    if res is None:
        raise ApiError("invalid_status", "Run not finished", status=409, retryable=True)
    return res


# -- request body ----------------------------------------------------------

class CreateRunBody(BaseModel):
    mode: str = Field(default="backtest", pattern="^backtest$")
    universe: str = Field(default=UNIVERSE_KEY, pattern="^djia_30$")
    start_date: str
    end_date: str
    agent_name: str = Field(default="external-agent", min_length=1, max_length=100)
    model_name: str = Field(default="local-model", min_length=1, max_length=100)
    strategy_mode: str = Field(default="safe_trading", pattern="^(safe_trading|buy_and_hold)$")


# -- endpoints -------------------------------------------------------------

@router.post("")
async def create_run(body: CreateRunBody, response: Response,
                     agent: dict = Depends(require_scope("runs:write"))):
    """Mint the canonical run_id, write the manifest, start the backtest load."""
    enforce(agent["agent_id"], response)
    run_id = _mint_run_id()
    backend = BacktestBackend(
        run_id=run_id, session_id=agent["session_id"], agent_name=body.agent_name,
        model_name=body.model_name, start_date=body.start_date, end_date=body.end_date,
        mode=body.strategy_mode,
    )
    manifest = RunManifest(
        agent_name=body.agent_name, model_name=body.model_name, mode="backtest",
        universe=UNIVERSE_KEY, start_date=body.start_date, end_date=body.end_date,
        decision_timeout_seconds=ext.DECISION_TIMEOUT_SECONDS,
        schema_version=SCHEMA_VERSION, news_sentiment_source=backend.news_sentiment_source,
    )
    db.insert_run_manifest(run_id, manifest.model_dump())
    backend.start_background_load()
    register_run(run_id, backend, agent["session_id"])
    return {
        "run_id": run_id, "mode": "backtest", "status": "loading",
        "loop": backend.loop, "decision_timeout_seconds": ext.DECISION_TIMEOUT_SECONDS,
    }


@router.get("/{run_id}")
async def run_status(run_id: str, agent: dict = Depends(require_scope("runs:read"))):
    backend = _require_run(run_id, agent["session_id"])
    return backend.status()


@router.get("/{run_id}/context")
async def get_context(run_id: str, response: Response,
                      agent: dict = Depends(require_scope("context:read"))):
    """get_context — typed context envelope for the current step."""
    enforce(agent["agent_id"], response)
    return _context_for(run_id, agent["session_id"])


@router.post("/{run_id}/decisions")
async def submit_decision(run_id: str, body: DecisionRequest, response: Response,
                          agent: dict = Depends(require_scope("decisions:write"))):
    """submit_decision — idempotent per (run_id, idempotency_key)."""
    enforce(agent["agent_id"], response)
    actions = [a.model_dump() for a in body.actions]
    return _submit_for(run_id, agent["session_id"], body.idempotency_key, actions)


@router.get("/{run_id}/result")
async def get_result(run_id: str, agent: dict = Depends(require_scope("runs:read"))):
    """get_result — metrics, equity, trades, decisions, manifest."""
    return _result_for(run_id, agent["session_id"])


@router.get("/{run_id}/decisions")
async def decisions_log(run_id: str, agent: dict = Depends(require_scope("runs:read"))):
    backend = _require_run(run_id, agent["session_id"])
    return {"run_id": run_id, "decisions": backend.session.get_decisions()
            if hasattr(backend, "session") else []}


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str, agent: dict = Depends(require_scope("runs:write"))):
    backend = _require_run(run_id, agent["session_id"])
    backend.cancel()
    return {"run_id": run_id, "status": "closed"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard/backend && pytest tests/test_v2_runs.py tests/test_v2_idempotency.py -v`
Expected: PASS (3 tests). They exercise the pure helpers with `FakeBackend`, no Alpaca.

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/v2/runs.py dashboard/backend/tests/test_v2_runs.py dashboard/backend/tests/test_v2_idempotency.py
git commit -m "feat(v2): add runs router with canonical run_id and idempotent decisions"
```

---

## Task 12: Self-describing schema endpoint

`GET /api/v2/schema` (spec §4.1) — publishes the context/decision schemas, universe, error codes, scopes, and version so clients are self-correcting.

**Files:**
- Create: `dashboard/backend/api/v2/schema.py`
- Test: `dashboard/backend/tests/test_v2_schema_api.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_schema_api.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from api.v2.schema import build_schema  # noqa: E402


def test_schema_publishes_contract_metadata():
    s = build_schema()
    assert s["schema_version"] == "2.0"
    assert s["universe_key"] == "djia_30"
    assert "AAPL" in s["universe"]
    assert "rate_limited" in s["error_codes"]
    assert "decisions:write" in s["scopes"]
    assert "context" in s["schemas"] and "decision" in s["schemas"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_schema_api.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.v2.schema'`.

- [ ] **Step 3: Implement the schema endpoint**

Create `dashboard/backend/api/v2/schema.py`:

```python
"""GET /api/v2/schema — self-describing contract (spec §4.1)."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from api.v2.errors import ERROR_CODES
from api.v2.models import (
    SCHEMA_VERSION, UNIVERSE, UNIVERSE_KEY, ContextEnvelope, DecisionRequest,
    ResultEnvelope, SubmitAck,
)
from auth_scopes import SCOPES

router = APIRouter(prefix="/v2", tags=["v2-schema"])


def build_schema() -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "universe_key": UNIVERSE_KEY,
        "universe": UNIVERSE,
        "error_codes": ERROR_CODES,
        "scopes": SCOPES,
        "loops": ["lockstep", "realtime"],
        "verbs": {
            "register": "POST /api/v2/agents",
            "get_context": "GET /api/v2/runs/{run_id}/context",
            "submit_decision": "POST /api/v2/runs/{run_id}/decisions",
            "get_result": "GET /api/v2/runs/{run_id}/result",
        },
        "schemas": {
            "context": ContextEnvelope.model_json_schema(),
            "decision": DecisionRequest.model_json_schema(),
            "submit_ack": SubmitAck.model_json_schema(),
            "result": ResultEnvelope.model_json_schema(),
        },
    }


@router.get("/schema")
async def get_schema():
    return build_schema()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_schema_api.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/v2/schema.py dashboard/backend/tests/test_v2_schema_api.py
git commit -m "feat(v2): add self-describing /schema endpoint"
```

---

## Task 13: v2 leaderboard endpoint

`GET /api/v2/leaderboard` (spec §4.1, §8.4) — ranks real v2 runs against their paired baselines.

**Files:**
- Create: `dashboard/backend/api/v2/leaderboard.py`
- Test: `dashboard/backend/tests/test_v2_leaderboard_api.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_leaderboard_api.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from api.v2.leaderboard import build_leaderboard  # noqa: E402


def test_build_leaderboard_ranks_v2_runs_by_return():
    runs = [
        {"run_id": "run_a", "agent_name": "A", "total_return": 0.05,
         "sharpe_ratio": 1.0, "max_drawdown": -0.02, "final_equity": 105000,
         "num_trades": 4, "llm_model": "m"},
        {"run_id": "run_b", "agent_name": "B", "total_return": 0.12,
         "sharpe_ratio": 1.5, "max_drawdown": -0.03, "final_equity": 112000,
         "num_trades": 7, "llm_model": "m"},
        {"run_id": "ext_legacy", "agent_name": "C", "total_return": 0.20},  # not v2
    ]
    board = build_leaderboard(runs)
    assert [e["run_id"] for e in board] == ["run_b", "run_a"]  # v2 only, ranked desc
    assert board[0]["rank"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_leaderboard_api.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'api.v2.leaderboard'`.

- [ ] **Step 3: Implement the leaderboard endpoint**

Create `dashboard/backend/api/v2/leaderboard.py`:

```python
"""GET /api/v2/leaderboard — rank real v2 runs vs baselines (spec §8.4)."""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter

from database import db

router = APIRouter(prefix="/v2", tags=["v2-leaderboard"])


def _is_v2_run(run: Dict[str, Any]) -> bool:
    return str(run.get("run_id", "")).startswith("run_")


def build_leaderboard(runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    v2_runs = [r for r in runs if _is_v2_run(r)]
    ranked = sorted(v2_runs, key=lambda r: (r.get("total_return") or -1e9), reverse=True)
    board = []
    for i, r in enumerate(ranked, start=1):
        board.append({
            "rank": i,
            "run_id": r.get("run_id"),
            "agent_name": r.get("agent_name"),
            "model": r.get("llm_model"),
            "total_return": r.get("total_return"),
            "sharpe_ratio": r.get("sharpe_ratio"),
            "max_drawdown": r.get("max_drawdown"),
            "num_trades": r.get("num_trades"),
            "final_equity": r.get("final_equity"),
            "baseline_djia_run_id": r.get("baseline_djia_run_id"),
            "baseline_buyhold_run_id": r.get("baseline_buyhold_run_id"),
        })
    return board


@router.get("/leaderboard")
async def leaderboard():
    return {"leaderboard": build_leaderboard(db.get_all_runs())}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_leaderboard_api.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/v2/leaderboard.py dashboard/backend/tests/test_v2_leaderboard_api.py
git commit -m "feat(v2): add leaderboard endpoint over real v2 runs"
```

---

## Task 14: Mount v2 router + error handler (wire it into the app)

Compose the sub-routers and mount under `/api/v2`; register the uniform error handler. This is what turns the green unit tests into a live HTTP surface and makes the Task 10 API tests pass.

**Files:**
- Create: `dashboard/backend/api/v2/router.py`, `dashboard/backend/tests/test_v2_http.py`
- Modify: `dashboard/backend/api/router.py`, `dashboard/backend/app.py`

- [ ] **Step 1: Write the failing test**

Create `dashboard/backend/tests/test_v2_http.py` (the live HTTP surface, end-to-end through the app):

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402

client = TestClient(app)


def test_register_returns_key_session_and_scopes():
    r = client.post("/api/v2/agents", json={"name": "v2-agent", "model_name": "gpt-x"})
    assert r.status_code == 200
    body = r.json()
    assert body["api_key"].startswith("ag_")
    assert body["session_id"]
    assert "decisions:write" in body["scopes"]


def test_me_resolves_from_api_key():
    reg = client.post("/api/v2/agents", json={"name": "v2-agent-2"}).json()
    r = client.get("/api/v2/agents/me", headers={"X-API-Key": reg["api_key"]})
    assert r.status_code == 200
    body = r.json()
    assert body["agent_id"]
    assert body["session_id"] == reg["session_id"]
    assert set(body["scopes"]) >= {"context:read", "decisions:write"}


def test_me_without_key_is_unauthorized_envelope():
    r = client.get("/api/v2/agents/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_schema_route_is_live():
    r = client.get("/api/v2/schema")
    assert r.status_code == 200
    assert r.json()["schema_version"] == "2.0"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard/backend && pytest tests/test_v2_http.py -v`
Expected: FAIL — `404` (v2 not mounted yet; the unauthorized/schema assertions miss).

- [ ] **Step 3: Compose and mount**

Create `dashboard/backend/api/v2/router.py`:

```python
"""Compose the /api/v2 surface."""

from fastapi import APIRouter

from api.v2.agents import router as agents_router
from api.v2.leaderboard import router as leaderboard_router
from api.v2.runs import router as runs_router
from api.v2.schema import router as schema_router

v2_router = APIRouter()
v2_router.include_router(agents_router)
v2_router.include_router(runs_router)
v2_router.include_router(schema_router)
v2_router.include_router(leaderboard_router)
```

In `dashboard/backend/api/router.py`, add the import and include (the `api_router` already has `prefix="/api"`, so `/v2/...` becomes `/api/v2/...`):

```python
from api.v2.router import v2_router as v2_router
```

and, after the existing `include_router` calls:

```python
api_router.include_router(v2_router)
```

In `dashboard/backend/app.py`, register the error handler. Add the import near the other `api`/router imports:

```python
from api.v2.errors import ApiError, api_error_handler
```

and, immediately after the `app = FastAPI(...)` construction (or wherever `app` is defined and before routers are added), register:

```python
app.add_exception_handler(ApiError, api_error_handler)
```

> Locate the existing `app = FastAPI(...)` line in `app.py` and place the `add_exception_handler` call right after it. If `app.py` includes `api_router` via `app.include_router(api_router)`, no further change is needed — the v2 routes ride along.

- [ ] **Step 4: Run the live HTTP suite to verify it passes**

Run: `cd dashboard/backend && pytest tests/test_v2_http.py -v`
Expected: PASS — register, me, unauthorized envelope, and the live `/api/v2/schema` route.

- [ ] **Step 5: Run the whole v2 test set + commit**

Run: `cd dashboard/backend && pytest tests/test_v2_contracts.py tests/test_v2_db.py tests/test_v2_auth.py tests/test_execution_backends.py tests/test_v2_parity.py tests/test_v2_runs.py tests/test_v2_idempotency.py tests/test_v2_agents_router.py tests/test_v2_http.py tests/test_v2_schema_api.py tests/test_v2_leaderboard_api.py tests/test_external_session_compat.py -v`
Expected: ALL PASS.

```bash
git add dashboard/backend/api/v2/router.py dashboard/backend/api/router.py dashboard/backend/app.py dashboard/backend/tests/test_v2_http.py
git commit -m "feat(v2): mount /api/v2 router and register error handler"
```

---

## Task 15: Reference client + documentation

The v2 contract in action (a runnable client) and the documented surface (spec §9 deliverables).

**Files:**
- Create: `dashboard/examples/external_agent_client_v2.py`, `docs/source/lab/agent_api.rst`
- Modify: `docs/source/lab/architecture.rst`

- [ ] **Step 1: Write the reference client**

Create `dashboard/examples/external_agent_client_v2.py`:

```python
"""Reference client for the /api/v2 agent contract (Plan 2).

Demonstrates the four canonical verbs end-to-end. The agent's LLM runs CLIENT-SIDE:
this script fetches context, decides locally (here: a trivial rule), and submits.
The backend only serves context and validates — it never calls your model.

Usage:
    python external_agent_client_v2.py --api http://localhost:8000 \
        --start 2026-04-15 --end 2026-04-16
"""

from __future__ import annotations

import argparse
import time
import uuid

import requests


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--name", default="v2-reference-agent")
    ap.add_argument("--model", default="local-model")
    args = ap.parse_args()

    base = args.api.rstrip("/")

    # 1) register → api_key (shown once)
    reg = requests.post(f"{base}/api/v2/agents",
                        json={"name": args.name, "model_name": args.model}).json()
    key = reg["api_key"]
    headers = {"X-API-Key": key}
    print(f"registered agent {reg['agent_id']} (scopes: {reg['scopes']})")

    # 2) create a run
    run = requests.post(f"{base}/api/v2/runs", headers=headers, json={
        "mode": "backtest", "universe": "djia_30",
        "start_date": args.start, "end_date": args.end,
        "agent_name": args.name, "model_name": args.model,
    }).json()
    run_id = run["run_id"]
    print(f"run {run_id} → {run['status']}")

    # 3) loop: get_context → decide locally → submit_decision
    while True:
        ctx = requests.get(f"{base}/api/v2/runs/{run_id}/context", headers=headers).json()
        status = ctx.get("status")
        if status == "loading":
            time.sleep(1.0)
            continue
        if status in ("completed", "closed", "failed"):
            break

        # ---- CLIENT-SIDE decision (replace with your LLM call) ----
        actions = []
        for sym, sig in list(ctx.get("top_signals", {}).items())[:3]:
            news = ctx.get("news_sentiment", {}).get(sym, {})
            if sig["rsi"] < 35 or news.get("sentiment") == "bullish":
                actions.append({
                    "action": "buy", "symbol": sym, "confidence": 0.7,
                    "reasoning": f"rsi={sig['rsi']:.0f}, news={news.get('sentiment','n/a')}",
                    "position_size": 5,
                })

        ack = requests.post(f"{base}/api/v2/runs/{run_id}/decisions", headers=headers, json={
            "idempotency_key": str(uuid.uuid4()), "actions": actions,
        }).json()
        print(f"step {ctx['step_index']}/{ctx['total_steps']} → "
              f"executed {len(ack.get('executed', []))}, status {ack.get('status')}")
        if ack.get("status") == "completed":
            break

    # 4) get_result
    result = requests.get(f"{base}/api/v2/runs/{run_id}/result", headers=headers).json()
    print("metrics:", result.get("metrics"))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write the API doc**

Create `docs/source/lab/agent_api.rst`:

```rst
Agent API (v2)
==============

The ``/api/v2`` surface is a typed, versioned, MCP-shaped contract any agent can
target. The agent's LLM runs **client-side**: the backend serves context and
validates decisions; it never calls your model.

Four canonical verbs
---------------------

+------------------+--------------------------------------------+
| Verb             | Endpoint                                   |
+==================+============================================+
| ``register``     | ``POST /api/v2/agents``                    |
| ``get_context``  | ``GET  /api/v2/runs/{run_id}/context``     |
| ``submit_decision`` | ``POST /api/v2/runs/{run_id}/decisions`` |
| ``get_result``   | ``GET  /api/v2/runs/{run_id}/result``      |
+------------------+--------------------------------------------+

Auth & scopes
-------------

Authenticate with ``X-API-Key: ag_...`` (returned once at registration). The key
carries ownership and scopes (``agents:register``, ``runs:write``, ``context:read``,
``decisions:write``, ``runs:read``). Per-agent rate limits return ``429`` with
``Retry-After`` and ``X-RateLimit-*`` headers.

Context envelope
----------------

``get_context`` returns a typed envelope: ``portfolio``, ``current_holdings``,
``recent_trades``, ``top_signals``, plus an explicit ``universe`` (DJIA-30), a
``loop`` field (``lockstep`` for backtest), and a guaranteed ``news_sentiment``
slot (one aggregated entry per ticker; empty ``{}`` until the sentiment signal is
wired). ``GET /api/v2/schema`` publishes the full schemas, error codes, and version.

Decisions & idempotency
------------------------

``submit_decision`` takes ``{idempotency_key, actions: [...]}``. Each action is
validated against the DJIA-30 universe and the trading schema; valid actions
execute, invalid ones are returned in ``rejected`` with reasons. Replaying an
``idempotency_key`` for the same step returns the original ack — no double execution.
Decision payloads are JSON-only; ``tool_calls``/``function_calls`` are rejected.

Reference client
----------------

See ``dashboard/examples/external_agent_client_v2.py`` for the full loop.
```

- [ ] **Step 3: Add the v2 row to the architecture doc**

In `docs/source/lab/architecture.rst`, add a row to the "API surface (summary)" table (after the `GET /config/defaults` row, before the closing `+---+`):

```rst
| ``/api/v2/*``             | Typed, scoped agent API (see :doc:`agent_api`) |
```

- [ ] **Step 4: Verify the client imports cleanly and docs reference resolves**

Run: `cd dashboard && python -c "import ast; ast.parse(open('examples/external_agent_client_v2.py').read()); print('client parses')"`
Expected: prints `client parses`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/examples/external_agent_client_v2.py docs/source/lab/agent_api.rst docs/source/lab/architecture.rst
git commit -m "docs(v2): add reference client and agent API documentation"
```

---

## Task 16: Full regression + spec-coverage verification

Confirm Phase A is complete and the existing suites still pass.

**Files:**
- No new files. Verification only.

- [ ] **Step 1: Run the entire backend test suite**

Run: `cd dashboard/backend && pytest tests/ -v`
Expected: ALL PASS — the new v2 suites plus the pre-existing tests (no regressions in `test_auth`, `test_llm_validator`, etc.).

- [ ] **Step 2: Boot the app and smoke-test the live surface**

Run:
```bash
cd dashboard/backend && python -c "from app import app; from fastapi.testclient import TestClient; c=TestClient(app); \
print('schema', c.get('/api/v2/schema').status_code); \
reg=c.post('/api/v2/agents', json={'name':'smoke'}).json(); \
print('register', 'api_key' in reg, reg.get('scopes')); \
print('me', c.get('/api/v2/agents/me', headers={'X-API-Key': reg['api_key']}).status_code); \
print('me-noauth', c.get('/api/v2/agents/me').status_code)"
```
Expected: `schema 200`, `register True [...]`, `me 200`, `me-noauth 401`.

- [ ] **Step 3: Confirm OpenAPI includes the v2 contract**

Run: `cd dashboard/backend && python -c "from app import app; paths=app.openapi()['paths']; print(sorted(p for p in paths if p.startswith('/api/v2')))"`
Expected: lists `/api/v2/agents`, `/api/v2/agents/me`, `/api/v2/agents/{agent_id}/rotate-key`, `/api/v2/runs`, `/api/v2/runs/{run_id}`, `/api/v2/runs/{run_id}/context`, `/api/v2/runs/{run_id}/decisions`, `/api/v2/runs/{run_id}/result`, `/api/v2/runs/{run_id}/cancel`, `/api/v2/schema`, `/api/v2/leaderboard`.

- [ ] **Step 4: Commit (final marker)**

```bash
git add -A
git commit -m "test(v2): full regression pass for Phase A agent API foundation" --allow-empty
```

---

## Spec coverage map (self-review)

| Spec section | Task(s) |
|---|---|
| §3.1 sentiment-signal slot (typed, fail-closed) | 5 (`NewsSentimentEntry`), 8 (`load_news_sentiment`) |
| §3.2 four canonical verbs | 10 (register), 11 (context/decisions/result) |
| §4.1 /api/v2 surface (all endpoints) | 10, 11, 12, 13, 14 |
| §4.2 ExecutionBackend (two parity kinds) | 6 (interface + paper stub), 8 (BacktestBackend), 9 (FakeBackend), parity test |
| §4.3 canonical run_id minted at creation | 7 (engine hook), 11 (mint + registry) |
| §5.1 context envelope (typed) | 5, 8 |
| §5.2 decision contract + idempotency | 5, 11 (idempotency), 2 (idempotency table) |
| §5.3 partial-execution ack | 8 (`apply_decisions`) |
| §5.4 error model (one envelope) | 3 (`ApiError`/handler), 14 (registration) |
| §6 auth/scopes/rate-limit | 1 (scopes column), 3 (`require_scope`), 4 (rate limiter), 10/11 (enforcement) |
| §7 lockstep lifecycle | 8 (wraps existing state machine), 11 (cancel) |
| §8.1 standardized metrics | 8 (`result`), 11 |
| §8.2 reproducibility manifest | 2 (table), 11 (write), 5 (`RunManifest`) |
| §8.3 per-decision context_ref | 2 (column), 7 (engine hook), 8 (hash + record) |
| §8.4 leaderboard over real v2 runs | 13 |
| §9 file map / flat-import rule | all (subpackages get `__init__.py`) |
| §10 testing strategy | every task is TDD; suites map 1:1 to the spec's test table |
| §13 backward compatibility | 7 (back-compat engine edits), 14 (additive mount; v1 untouched) |

**Deferred (designed-for, per spec §11–12, intentionally NOT in Phase A):** `PaperBackend`/`LiveBackend` execution (Phase B), the MCP façade (Phase C), durable cross-worker run state, universe expansion beyond DJIA-30.

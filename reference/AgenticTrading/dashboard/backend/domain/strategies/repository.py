"""SQLite repository for free-form strategy prompts.

Each strategy is keyed by a short, URL-safe share ``code`` and stored in a
``strategies`` table in the main application database (``DATABASE_PATH``).

Why SQLite and not a JSON file (the previous implementation): the JSON file lived
under the repo's ``storage/data`` dir, which is **ephemeral** on Render — it was
wiped on every deploy, silently losing every saved strategy. The database, by
contrast, is resolved from ``DATABASE_PATH`` and mounted on Render's persistent
disk, so strategies now survive deploys. SQLite's own file locking also makes
concurrent access from separate processes (e.g. a co-hosted bot) safe, which the
old process-local ``threading.Lock`` could not provide.

The public module-level functions (``create_strategy`` / ``get_strategy`` /
``set_last_run``) are unchanged, so callers need no edits.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from dashboard.backend.database import DB_PATH
from dashboard.backend.db_url import describe_database_url

# Length of the generated share code (hex chars). 8 hex chars = 32 bits, plenty
# for human-shareable, non-guessable-enough codes at this scale.
_CODE_LENGTH = 8


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _public(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "code": row["code"],
        "prompt": row["prompt"],
        "description": row["description"],
        "source": row["source"],
        "owner": row["owner"],
        "created_at": row["created_at"],
        "last_run_id": row["last_run_id"],
        "last_run_at": row["last_run_at"],
    }


class StrategyStore:
    """Persist free-form strategy prompts in the shared application database."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = Path(db_path or DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS strategies (
                code TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                description TEXT,
                source TEXT,
                owner TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_run_id TEXT,
                last_run_at TIMESTAMP
            )
            """
        )
        conn.commit()
        conn.close()

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
        conn = self._connect()
        try:
            def _insert(candidate: str) -> bool:
                # The PRIMARY KEY makes uniqueness atomic even across processes.
                try:
                    conn.execute(
                        "INSERT INTO strategies "
                        "(code, prompt, description, source, owner, created_at, last_run_id, last_run_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
                        (candidate, cleaned, desc, source or None, owner or None, now),
                    )
                    conn.commit()
                    return True
                except sqlite3.IntegrityError:
                    return False

            code = None
            for _ in range(20):
                candidate = secrets.token_hex(_CODE_LENGTH // 2)
                if _insert(candidate):
                    code = candidate
                    break
            if code is None:
                # Astronomically unlikely: widen the code space (64 bits) and try
                # once more, matching the old store's graceful fallback rather
                # than surfacing a 500.
                candidate = secrets.token_hex(_CODE_LENGTH)
                if not _insert(candidate):
                    raise RuntimeError("Could not allocate a unique strategy code")
                code = candidate
            row = conn.execute("SELECT * FROM strategies WHERE code = ?", (code,)).fetchone()
            return _public(row)
        finally:
            conn.close()

    def get(self, code: str) -> Optional[dict[str, Any]]:
        if not code:
            return None
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM strategies WHERE code = ?", (code,)).fetchone()
            return _public(row) if row else None
        finally:
            conn.close()

    def set_last_run(self, code: str, run_id: str) -> Optional[dict[str, Any]]:
        conn = self._connect()
        try:
            cur = conn.execute(
                "UPDATE strategies SET last_run_id = ?, last_run_at = ? WHERE code = ?",
                (run_id, _now_iso(), code),
            )
            conn.commit()
            if cur.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM strategies WHERE code = ?", (code,)).fetchone()
            return _public(row) if row else None
        finally:
            conn.close()


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


# ----------------------------------------------------------------------
# Backwards-compatible module-level API (callers import these names directly).
# ----------------------------------------------------------------------


def create_strategy(
    *,
    prompt: str,
    description: Optional[str] = None,
    source: Optional[str] = None,
    owner: Optional[str] = None,
) -> dict[str, Any]:
    """Persist a free-form strategy prompt and return the stored record."""
    return strategy_store.create(
        prompt=prompt, description=description, source=source, owner=owner
    )


def get_strategy(code: str) -> Optional[dict[str, Any]]:
    """Return the stored strategy for ``code`` or ``None``."""
    return strategy_store.get(code)


def set_last_run(code: str, run_id: str) -> Optional[dict[str, Any]]:
    """Attach the latest backtest run id to a strategy (best-effort)."""
    return strategy_store.set_last_run(code, run_id)

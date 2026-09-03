"""SQLite portfolio store for account-bound cash ledgers.

Selected when ``CONTENT_DATABASE_URL`` is unset. Postgres twin:
``repository_postgres.PostgresPortfolioStore``.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from dashboard.backend.database import DB_PATH
from dashboard.backend.db_url import describe_database_url
from dashboard.backend.domain.backtesting.constants import DEFAULT_PORTFOLIO_EQUITY


class InsufficientCashError(ValueError):
    """Raised when a transfer would drive cash_available below zero.

    Raised by ``PortfolioService``, not by the stores: whether a transfer fits
    depends on the *agent sleeves*, which live in a different table, so the
    portfolio row alone cannot answer the question. See ``service._reconcile``.
    """


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _public_portfolio(row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Any]:
    data = dict(row)
    equity = float(data.get("equity") or 0)
    cash_available = float(data.get("cash_available") or 0)
    return {
        "owner_user_id": int(data["owner_user_id"]),
        "equity": equity,
        "cash_available": cash_available,
        "allocated": max(equity - cash_available, 0.0),
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
    }


class PortfolioStore:
    """Persist one portfolio row per signed-in user."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = Path(db_path or DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _get_connection(self) -> sqlite3.Connection:
        # ``timeout`` is the busy-handler wait, not a connect deadline: without
        # it a writer that meets a held write lock raises "database is locked"
        # immediately instead of queuing behind it.
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        # Runs once per process, from __init__ (same as every other store).
        # ADDING A COLUMN LATER (#175 allocate/reclaim)? It needs its own
        # `ALTER TABLE ... ADD COLUMN` guarded by an OperationalError catch,
        # *not* only a new line in the CREATE below: CREATE TABLE IF NOT EXISTS
        # silently no-ops once the table exists, so a deployment whose table
        # predates the column would never gain it. Mirror the change in
        # repository_postgres.py, which carries the same warning.
        conn = self._get_connection()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_portfolios (
                owner_user_id INTEGER PRIMARY KEY,
                equity REAL NOT NULL,
                cash_available REAL NOT NULL,
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP NOT NULL
            )
            """
        )
        conn.commit()
        conn.close()

    def get(self, owner_user_id: int) -> Optional[Dict[str, Any]]:
        conn = self._get_connection()
        row = conn.execute(
            "SELECT * FROM user_portfolios WHERE owner_user_id = ?",
            (int(owner_user_id),),
        ).fetchone()
        conn.close()
        return _public_portfolio(row) if row else None

    def create(
        self,
        owner_user_id: int,
        *,
        equity: float = DEFAULT_PORTFOLIO_EQUITY,
    ) -> Dict[str, Any]:
        now = _utcnow_iso()
        equity_f = float(equity)
        conn = self._get_connection()
        conn.execute(
            """
            INSERT INTO user_portfolios (
                owner_user_id, equity, cash_available, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (int(owner_user_id), equity_f, equity_f, now, now),
        )
        conn.commit()
        conn.close()
        created = self.get(owner_user_id)
        if created is None:  # pragma: no cover - the INSERT above just committed
            raise RuntimeError(
                f"portfolio for user {owner_user_id} vanished immediately after INSERT"
            )
        return created

    def get_or_create(
        self,
        owner_user_id: int,
        *,
        equity: float = DEFAULT_PORTFOLIO_EQUITY,
    ) -> Dict[str, Any]:
        existing = self.get(owner_user_id)
        if existing is not None:
            return existing
        try:
            return self.create(owner_user_id, equity=equity)
        except sqlite3.IntegrityError:
            # Concurrent bootstrap — return the winner's row.
            raced = self.get(owner_user_id)
            if raced is None:
                raise
            return raced

    def set_cash_available(
        self, owner_user_id: int, cash_available: float
    ) -> Dict[str, Any]:
        """Overwrite cash_available with an already-validated figure.

        Deliberately a *blind* write rather than a read-modify-write delta:
        ``service._reconcile`` derives the correct value from the agent sleeves
        (a different table), so re-reading this row here would add a race
        window without adding any information. Bounds are the service's job.
        """
        self.get_or_create(owner_user_id)
        uid = int(owner_user_id)
        value = float(cash_available)
        now = _utcnow_iso()
        conn = self._get_connection()
        try:
            # BEGIN IMMEDIATE takes the write lock up front. Python's sqlite3
            # otherwise defers it to the UPDATE, leaving concurrent writers to
            # collide mid-statement.
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                UPDATE user_portfolios
                SET cash_available = ?, updated_at = ?
                WHERE owner_user_id = ?
                """,
                (value, now, uid),
            )
            conn.commit()
        finally:
            conn.close()
        updated = self.get(uid)
        if updated is None:  # pragma: no cover - the UPDATE above just committed
            raise RuntimeError(f"portfolio for user {uid} vanished during update")
        return updated


def _build_portfolio_store():
    database_url = os.getenv("CONTENT_DATABASE_URL")
    if database_url:
        from dashboard.backend.domain.portfolios.repository_postgres import (
            PostgresPortfolioStore,
        )

        print(
            f"portfolio_store backend: postgres ({describe_database_url(database_url)})"
        )
        return PostgresPortfolioStore(database_url)
    print("portfolio_store backend: sqlite (ephemeral on Render)")
    return PortfolioStore()


portfolio_store = _build_portfolio_store()

"""Immutable AgentVersion snapshots.

An AgentVersion captures the configuration (model, architecture, prompt/config
hashes, etc.) of an Agent at a point in time. Versions are immutable once
created: changing a strategy means creating a new version. Runs reference a
specific AgentVersion so results are always tied to a reproducible config.

Moved verbatim (Phase 3A1) from ``dashboard/backend/agent_version_store.py``;
the original module was removed in Phase 4A. Public classes, constants, the
``agent_version_store`` singleton, SQL, return schemas, and behavior are
unchanged; only the module location moved.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from dashboard.backend.database import DB_PATH
from dashboard.backend.db_url import describe_database_url

VALID_EXECUTION_MODES = {"external", "hosted"}
VALID_VERIFICATION_LEVELS = {"self_reported", "platform_verified", "code_audited"}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _new_version_id() -> str:
    return f"agv_{uuid.uuid4().hex[:12]}"


def _short_hash(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, sort_keys=True, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _public_version(row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Any]:
    data = dict(row)
    try:
        backbones = json.loads(data.get("model_backbones") or "[]")
    except (json.JSONDecodeError, TypeError):
        backbones = []
    return {
        "agent_version_id": data["agent_version_id"],
        "agent_id": data["agent_id"],
        "version": data.get("version"),
        "execution_mode": data.get("execution_mode"),
        "architecture": data.get("architecture"),
        "model_backbones": backbones,
        "decision_frequency": data.get("decision_frequency"),
        "code_commit": data.get("code_commit"),
        "prompt_hash": data.get("prompt_hash"),
        "config_hash": data.get("config_hash"),
        "verification_level": data.get("verification_level"),
        "created_at": data.get("created_at"),
    }


class AgentVersionStore:
    """Persist immutable agent version snapshots."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = Path(db_path or DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_agent_versions_agent
            ON agent_versions(agent_id, created_at)
            """
        )
        conn.commit()
        conn.close()

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

        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO agent_versions (
                agent_version_id, agent_id, version, execution_mode, architecture,
                model_backbones, decision_frequency, code_commit, prompt_hash,
                config_hash, verification_level, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        conn.commit()
        cursor.execute(
            "SELECT * FROM agent_versions WHERE agent_version_id = ?",
            (agent_version_id,),
        )
        row = cursor.fetchone()
        conn.close()
        return _public_version(row)

    def get_version(self, agent_version_id: str) -> Optional[Dict[str, Any]]:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM agent_versions WHERE agent_version_id = ?",
            (agent_version_id,),
        )
        row = cursor.fetchone()
        conn.close()
        return _public_version(row) if row else None

    def list_versions(self, agent_id: str) -> List[Dict[str, Any]]:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT * FROM agent_versions
            WHERE agent_id = ?
            ORDER BY created_at DESC, agent_version_id DESC
            """,
            (agent_id,),
        )
        rows = cursor.fetchall()
        conn.close()
        return [_public_version(row) for row in rows]


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

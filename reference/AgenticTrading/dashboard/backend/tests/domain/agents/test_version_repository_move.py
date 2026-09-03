"""Phase 3A1 — agent-version repository move + characterization.

Verifies identity/re-export and that ``AgentVersionStore`` behaves exactly as
before, using an isolated temporary SQLite database.
"""

import ast
from pathlib import Path

import pytest

from dashboard.backend.domain.agents import version_repository
from dashboard.backend.domain.agents.version_repository import (
    VALID_EXECUTION_MODES,
    VALID_VERIFICATION_LEVELS,
    AgentVersionStore,
)


@pytest.fixture
def store(tmp_path):
    return AgentVersionStore(db_path=tmp_path / "versions.db")


# ---------------------------------------------------------------------------
# Canonical identity / constants
# ---------------------------------------------------------------------------

def test_canonical_module_identity():
    assert version_repository.AgentVersionStore.__module__ == (
        "dashboard.backend.domain.agents.version_repository"
    )


def test_constants_unchanged():
    assert VALID_EXECUTION_MODES == {"external", "hosted"}
    assert VALID_VERIFICATION_LEVELS == {
        "self_reported", "platform_verified", "code_audited"
    }


def test_domain_module_does_not_import_api_or_scripts():
    tree = ast.parse(Path(version_repository.__file__).read_text(encoding="utf-8"))
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            mods.add(node.module)
    for m in mods:
        assert not m.startswith("dashboard.backend.api"), m
        assert not m.startswith("dashboard.scripts"), m
        assert m != "fastapi" and not m.startswith("fastapi."), m


# ---------------------------------------------------------------------------
# AgentVersionStore characterization
# ---------------------------------------------------------------------------

def test_create_version_schema(store):
    v = store.create_version(
        agent_id="agent_1",
        version="v1",
        model_backbones=["gpt-x", "claude-y"],
        prompt="hello prompt",
        config={"a": 1},
    )
    assert set(v.keys()) == {
        "agent_version_id", "agent_id", "version", "execution_mode", "architecture",
        "model_backbones", "decision_frequency", "code_commit", "prompt_hash",
        "config_hash", "verification_level", "created_at",
    }
    assert v["agent_version_id"].startswith("agv_")
    assert v["agent_id"] == "agent_1"
    assert v["version"] == "v1"
    assert v["execution_mode"] == "external"  # default
    assert v["decision_frequency"] == "1h"  # default
    assert v["verification_level"] == "self_reported"  # default
    assert v["model_backbones"] == ["gpt-x", "claude-y"]
    assert isinstance(v["prompt_hash"], str) and len(v["prompt_hash"]) == 16
    assert isinstance(v["config_hash"], str) and len(v["config_hash"]) == 16


def test_create_version_explicit_hashes_and_defaults(store):
    v = store.create_version(
        agent_id="agent_2",
        version="v9",
        execution_mode="hosted",
        prompt_hash="deadbeef",
        config_hash="cafef00d",
        verification_level="code_audited",
    )
    assert v["execution_mode"] == "hosted"
    assert v["prompt_hash"] == "deadbeef"
    assert v["config_hash"] == "cafef00d"
    assert v["verification_level"] == "code_audited"
    assert v["model_backbones"] == []  # none provided


def test_get_version_and_missing(store):
    created = store.create_version(agent_id="agent_1", version="v1")
    fetched = store.get_version(created["agent_version_id"])
    assert fetched["agent_version_id"] == created["agent_version_id"]
    assert store.get_version("missing") is None


def test_list_versions_ordering_and_filter(store):
    ids = [store.create_version(agent_id="agent_1", version=f"v{i}")["agent_version_id"]
           for i in range(3)]
    store.create_version(agent_id="agent_other", version="x1")

    listed = store.list_versions("agent_1")
    assert {v["agent_version_id"] for v in listed} == set(ids)
    # Ordering: created_at DESC, agent_version_id DESC.
    keys = [(v["created_at"], v["agent_version_id"]) for v in listed]
    assert keys == sorted(keys, reverse=True)

    assert [v["agent_id"] for v in store.list_versions("agent_other")] == ["agent_other"]
    assert store.list_versions("nobody") == []

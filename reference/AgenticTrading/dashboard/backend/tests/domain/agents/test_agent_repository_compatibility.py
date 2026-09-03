"""Phase 3A1 — cross-repository + consumer-import boundary.

Confirms the two repositories share one DB cleanly, and runtime backend
consumers import the canonical domain modules (the legacy flat shims have been
removed).
"""

import ast
from pathlib import Path

import pytest

from dashboard.backend.domain.agents.repository import AgentStore
from dashboard.backend.domain.agents.version_repository import AgentVersionStore

_REPO_ROOT = Path(__file__).resolve().parents[5]
_BACKEND = _REPO_ROOT / "dashboard" / "backend"

SHIM_MODULES = {
    "dashboard.backend.agent_store",
    "dashboard.backend.agent_version_store",
}

# Runtime backend consumers that previously imported the flat shim modules.
# The agent routers moved to the canonical ``api/routers`` package in Phase 3A3
# and the run router in Phase 3B3; the old ``api/agents.py`` /
# ``api/agent_versions.py`` / ``api/runs.py`` are now thin shims, so the canonical
# router modules are the real domain consumers.
CONSUMERS = [
    _BACKEND / "api" / "routers" / "agents.py",
    _BACKEND / "api" / "routers" / "agent_versions.py",
    _BACKEND / "api" / "protocol_auth.py",
    _BACKEND / "api" / "routers" / "runs.py",
    _BACKEND / "domain" / "backtesting" / "external_run_service.py",
]


def _import_froms(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return [n.module for n in ast.walk(tree)
            if isinstance(n, ast.ImportFrom) and n.module]


# ---------------------------------------------------------------------------
# Runtime consumers use canonical domain imports, not the (removed) shims
# ---------------------------------------------------------------------------

def test_consumers_use_canonical_domain_imports():
    offenders = []
    uses_domain = []
    for path in CONSUMERS:
        modules = _import_froms(path)
        if any(m in SHIM_MODULES for m in modules):
            offenders.append(path.name)
        if any(m.startswith("dashboard.backend.domain.agents") for m in modules):
            uses_domain.append(path.name)
    assert offenders == [], f"consumers still import shim modules: {offenders}"
    # Every consumer should now reference the canonical domain package.
    assert set(uses_domain) == {p.name for p in CONSUMERS}


# ---------------------------------------------------------------------------
# Cross-repository characterization (shared DB)
# ---------------------------------------------------------------------------

@pytest.fixture
def repos(tmp_path):
    db = tmp_path / "shared.db"
    return AgentStore(db_path=db), AgentVersionStore(db_path=db)


def test_versions_belong_to_their_agent(repos):
    agents, versions = repos
    a = agents.create_agent(name="A")
    b = agents.create_agent(name="B")

    va = versions.create_version(agent_id=a["agent_id"], version="v1")
    versions.create_version(agent_id=b["agent_id"], version="v1")

    a_versions = versions.list_versions(a["agent_id"])
    assert [v["agent_version_id"] for v in a_versions] == [va["agent_version_id"]]
    # A version of agent A is not retrievable through agent B's listing.
    b_ids = {v["agent_version_id"] for v in versions.list_versions(b["agent_id"])}
    assert va["agent_version_id"] not in b_ids


def test_repositories_share_one_database(repos):
    agents, versions = repos
    assert Path(agents.db_path) == Path(versions.db_path)
    a = agents.create_agent(name="A")
    versions.create_version(agent_id=a["agent_id"], version="v1")
    assert len(versions.list_versions(a["agent_id"])) == 1

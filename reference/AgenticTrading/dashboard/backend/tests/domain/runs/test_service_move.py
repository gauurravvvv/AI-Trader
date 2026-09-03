"""Phase 3B1 — run service move + lightweight characterization.

Verifies the service moved to the canonical domain package while the old module
remains a re-export shim, that it wires the canonical run repository, and that
the framework-free pieces (``ProtocolRun`` state, ``_get_run`` lookup) behave as
before. Engine-coupled flows are exercised end-to-end by ``test_protocol_api``.
"""

import ast
from pathlib import Path

import pytest

from dashboard.backend.domain.runs import repository, service
from dashboard.backend.domain.runs.repository import RunStore
from dashboard.backend.domain.runs.protocol import ProtocolError

_PUBLIC_FUNCS = [
    "create_run", "run_view", "run_status", "get_next_step", "get_step",
    "submit_decision", "list_steps", "list_decisions", "list_trades",
    "get_metrics", "get_result",
]


# ---------------------------------------------------------------------------
# Canonical wiring
# ---------------------------------------------------------------------------

def test_canonical_public_callables_present():
    for name in _PUBLIC_FUNCS:
        assert callable(getattr(service, name)), name
    assert service.ProtocolRun.__module__ == "dashboard.backend.domain.runs.service"


def test_service_wires_canonical_repository():
    assert service.run_store is repository.run_store


def test_service_does_not_import_api_or_scripts():
    tree = ast.parse(Path(service.__file__).read_text(encoding="utf-8"))
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
# ProtocolRun pure state behavior
# ---------------------------------------------------------------------------

def _make_run_obj():
    record = {
        "run_id": "run_abc",
        "session_id": "sess-1",
        "backtest_id": None,
        "config": {"symbols": ["AAPL"]},
        "result_run_id": None,
        "status": "running",
    }
    environment = {
        "universe": ["AAPL", "MSFT"],
        "constraints": {"allow_short": True, "max_position_weight": 0.5, "max_orders": 3},
    }
    return service.ProtocolRun(record=record, environment=environment)


def test_protocol_run_ensure_step_id_is_stable():
    run = _make_run_obj()
    sid = run.ensure_step_id(0, "2026-04-15T10:00:00", "2026-04-15T10:05:00")
    assert sid.startswith("step_")
    assert run.step_seq[sid] == 0
    assert run.seq_to_step_id[0] == sid
    assert run.step_meta[sid]["status"] == "awaiting_decision"
    # Same sequence returns the same id (updates meta, no new id).
    again = run.ensure_step_id(0, "2026-04-15T11:00:00", "2026-04-15T11:05:00")
    assert again == sid
    assert run.step_meta[sid]["timestamp"] == "2026-04-15T11:00:00"


def test_protocol_run_constraints_use_config_and_env():
    run = _make_run_obj()
    c = run.constraints()
    assert c["allowed_symbols"] == ["AAPL"]  # config.symbols wins over env.universe
    assert c["allow_short"] is True
    assert c["max_position_weight"] == 0.5
    assert c["max_orders"] == 3


def test_protocol_run_constraints_default_to_env_universe():
    run = _make_run_obj()
    run.config = {}
    assert run.constraints()["allowed_symbols"] == ["AAPL", "MSFT"]


# ---------------------------------------------------------------------------
# _get_run lookup against an isolated store
# ---------------------------------------------------------------------------

@pytest.fixture
def isolated_service(tmp_path, monkeypatch):
    store = RunStore(db_path=tmp_path / "svc.db")
    monkeypatch.setattr(service, "run_store", store)
    monkeypatch.setattr(service, "_runs", {})
    return store


def test_get_run_missing_raises_protocol_error(isolated_service):
    with pytest.raises(ProtocolError) as exc:
        service._get_run("run_missing")
    assert exc.value.code == "run_not_found"
    assert exc.value.status_code == 404


def test_get_run_rehydrates_from_store(isolated_service):
    record = isolated_service.create_run(
        agent_id="agent_1",
        agent_version_id="agv_1",
        session_id="sess-1",
        environment_id="unknown-env",
        environment_type="backtest",
        config={"start_date": "2026-04-15", "end_date": "2026-04-16"},
    )
    run = service._get_run(record["run_id"])
    assert run.run_id == record["run_id"]
    # Cached in the in-memory registry after first lookup.
    assert record["run_id"] in service._runs

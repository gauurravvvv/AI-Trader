"""Phase 3B2 — run environment registry move + characterization.

Verifies identity/re-export, the domain->api/scripts import boundary, the
registry contract, lookup behavior, and that the run service consumes the
canonical environment module.
"""

import ast
from pathlib import Path

from dashboard.backend.domain.runs import environment as canon
from dashboard.backend.domain.runs import service


# ---------------------------------------------------------------------------
# Canonical wiring
# ---------------------------------------------------------------------------

def test_service_uses_canonical_environment():
    assert service.get_environment is canon.get_environment


# ---------------------------------------------------------------------------
# Import boundary
# ---------------------------------------------------------------------------

def test_domain_module_does_not_import_api_or_scripts():
    tree = ast.parse(Path(canon.__file__).read_text(encoding="utf-8"))
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            mods.add(node.module)
    for m in mods:
        assert not m.startswith("dashboard.backend.api"), m
        assert not m.startswith("dashboard.scripts"), m


# ---------------------------------------------------------------------------
# Registry contract
# ---------------------------------------------------------------------------

def test_default_environment_id():
    assert canon.default_environment_id() == "us-equity-hourly-v1"


def test_get_environment_known_and_unknown():
    env = canon.get_environment("us-equity-hourly-v1")
    assert env is not None
    assert env["environment_id"] == "us-equity-hourly-v1"
    assert env["type"] == "backtest"
    assert env["asset_class"] == "us_equity"
    assert env["frequency"] == "1h"
    assert env["supported_action_schema"] == "orders-v1"
    assert env["supports_shorting"] is False
    assert env["initial_cash"] == 1000
    assert env["constraints"] == {
        "allow_short": False,
        "max_position_weight": 0.25,
        "max_orders": 10,
        "min_confidence": 0.3,
    }
    assert len(env["universe"]) == 30
    assert canon.get_environment("does-not-exist") is None


def test_list_environments_returns_registry():
    envs = canon.list_environments()
    ids = {e["environment_id"] for e in envs}
    assert ids == {"us-equity-hourly-v1"}

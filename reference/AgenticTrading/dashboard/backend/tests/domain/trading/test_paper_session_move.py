"""Focused tests for the paper-trading session move (Phase 3C5B).

Verifies canonical imports, old-module re-export identity, session creation and
stored fields, session state behavior, runtime-consumer import wiring, and import
boundaries. No network/provider access is involved.
"""

import ast
from pathlib import Path

from dashboard.backend.domain.trading.paper_session import (
    PaperTradingSession,
    create_paper_trading_session,
)

_BACKEND = Path(__file__).resolve().parents[3]


def _imported_modules(path: Path):
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name)
    return modules


# ---------------------------------------------------------------------------
# Session creation + stored fields
# ---------------------------------------------------------------------------

def test_create_paper_trading_session_run_id_format():
    run_id = create_paper_trading_session("MyAgent")
    assert run_id.startswith("MyAgent_")
    # Suffix is <YYYYmmdd_HHMMSS>_<uuid8 hex> — the uuid8 makes the id
    # collision-resistant for two sessions started in the same second.
    suffix = run_id[len("MyAgent_"):]
    ts, sep, uid = suffix.rpartition("_")
    assert sep == "_"
    assert len(ts) == 15 and ts[8] == "_" and ts.replace("_", "").isdigit()
    assert len(uid) == 8 and all(c in "0123456789abcdef" for c in uid)


def test_session_initial_fields():
    session = PaperTradingSession(run_id="r1", agent_name="A")
    assert session.run_id == "r1"
    assert session.agent_name == "A"
    assert session.equity_history == []
    assert session.trades_log == []
    assert session.last_equity is None
    assert session.initial_equity is None
    assert session.start_time is not None


# ---------------------------------------------------------------------------
# Session state behavior
# ---------------------------------------------------------------------------

def test_add_equity_snapshot_sets_initial_and_last():
    session = PaperTradingSession("r", "A")
    session.add_equity_snapshot(equity=100.0, cash=40.0, positions_value=60.0)
    assert session.initial_equity == 100.0
    assert session.last_equity == 100.0
    assert len(session.equity_history) == 1
    snap = session.equity_history[0]
    assert snap["equity"] == 100.0
    assert snap["cash"] == 40.0
    assert snap["positions_value"] == 60.0
    assert snap["daily_return"] is None
    assert "timestamp" in snap

    session.add_equity_snapshot(equity=110.0, cash=40.0, positions_value=70.0, daily_return=0.1)
    assert session.initial_equity == 100.0  # unchanged
    assert session.last_equity == 110.0
    assert session.equity_history[1]["daily_return"] == 0.1


def test_add_trade_records_value():
    session = PaperTradingSession("r", "A")
    session.add_trade(symbol="AAPL", qty=10, side="buy", price=5.0, reason="signal")
    assert len(session.trades_log) == 1
    trade = session.trades_log[0]
    assert trade["symbol"] == "AAPL"
    assert trade["qty"] == 10
    assert trade["side"] == "buy"
    assert trade["price"] == 5.0
    assert trade["value"] == 50.0
    assert trade["reason"] == "signal"
    assert "timestamp" in trade


def test_get_metrics_empty_returns_empty_dict():
    session = PaperTradingSession("r", "A")
    assert session.get_metrics() == {}


def test_get_metrics_computes_return_and_drawdown():
    session = PaperTradingSession("r", "A")
    session.add_equity_snapshot(equity=100.0, cash=0.0, positions_value=100.0)
    session.add_equity_snapshot(equity=120.0, cash=0.0, positions_value=120.0)
    session.add_equity_snapshot(equity=90.0, cash=0.0, positions_value=90.0)
    session.add_trade("AAPL", 1, "buy", 1.0)

    metrics = session.get_metrics()
    assert metrics["total_return"] == -10.0  # (90-100)/100 * 100
    assert metrics["final_equity"] == 90.0
    assert metrics["num_trades"] == 1
    # Max drawdown from peak 120 to trough 90 = -25%.
    assert metrics["max_drawdown"] == -25.0


# ---------------------------------------------------------------------------
# Runtime consumer + import boundaries
# ---------------------------------------------------------------------------

def test_app_uses_canonical_paper_session():
    # Phase 3C5C: the paper routes moved to the canonical router, which is now
    # the runtime consumer of the session helper.
    mods = _imported_modules(
        _BACKEND / "api" / "routers" / "paper_trading.py"
    )
    assert "dashboard.backend.domain.trading.paper_session" in mods


def test_paper_session_module_has_no_api_or_scripts_imports():
    mods = _imported_modules(
        _BACKEND / "domain" / "trading" / "paper_session.py"
    )
    for m in mods:
        assert not m.startswith("dashboard.backend.api"), m
        assert not m.startswith("dashboard.scripts"), m

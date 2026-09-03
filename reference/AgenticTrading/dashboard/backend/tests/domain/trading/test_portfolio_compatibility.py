"""Compatibility / legacy-equivalence tests for Phase 2B2.

Verifies that the legacy ``PortfolioManager`` methods (still defined in
``dashboard/scripts/backtest_hourly_agent.py``) produce output identical to the
extracted canonical helpers, that constructor/state/schema are unchanged, and
that subclassing still works.
"""

import pandas as pd

from dashboard.backend.domain.trading import portfolio as canonical
from dashboard.scripts import backtest_hourly_agent as bha


def _row(close, **kwargs):
    data = {"close": close}
    data.update(kwargs)
    return pd.Series(data)


def _make_manager():
    pm = bha.PortfolioManager(100000)
    pm.positions = {"AAPL": 10, "MSFT": 5}
    pm.entry_prices = {"AAPL": 200.0, "MSFT": 400.0}
    return pm


def _golden_md():
    return {"AAPL": _row(200.0, rsi_14=55.0), "MSFT": _row(400.0)}


# ---------------------------------------------------------------------------
# constructor / initial state
# ---------------------------------------------------------------------------

def test_initial_state_attributes():
    pm = bha.PortfolioManager(100000)
    assert pm.initial_capital == 100000
    assert pm.cash == 100000
    assert pm.positions == {}
    assert pm.entry_prices == {}
    assert pm.trades == []
    assert pm.equity_history == []
    assert pm.llm_calls == 0
    assert pm.input_tokens == 0
    assert pm.output_tokens == 0


def test_initial_portfolio_state():
    pm = bha.PortfolioManager(100000)
    state = pm.get_portfolio_state({})
    assert state["cash"] == 100000
    assert state["positions"] == []
    assert state["positions_value"] == 0
    assert state["total_equity"] == 100000
    assert state["market_signals"] == {}


# ---------------------------------------------------------------------------
# legacy equivalence: get_portfolio_state
# ---------------------------------------------------------------------------

def test_get_portfolio_state_matches_canonical():
    pm = _make_manager()
    md = _golden_md()
    legacy = pm.get_portfolio_state(md)
    canon = canonical.build_portfolio_state(
        pm.cash, pm.positions, pm.entry_prices, md
    )
    assert legacy == canon


def test_get_portfolio_state_golden_values():
    pm = _make_manager()
    state = pm.get_portfolio_state(_golden_md())
    assert state["cash"] == 100000
    assert state["positions_value"] == 4000.0
    assert state["total_equity"] == 104000.0
    aapl = next(p for p in state["positions"] if p["symbol"] == "AAPL")
    assert aapl == {
        "symbol": "AAPL",
        "shares": 10,
        "entry_price": 200.0,
        "current_price": 200.0,
        "position_value": 2000.0,
        "pnl_pct": 0.0,
    }
    assert state["market_signals"]["AAPL"]["rsi"] == 55.0


def test_get_portfolio_state_with_price_cache_fallback():
    pm = _make_manager()
    md = {"AAPL": _row(200.0)}  # MSFT only in cache
    cache = {"MSFT": {"t0": 400.0}}
    legacy = pm.get_portfolio_state(md, price_cache=cache, timestamp="t0")
    canon = canonical.build_portfolio_state(
        pm.cash, pm.positions, pm.entry_prices, md, cache, "t0"
    )
    assert legacy == canon
    assert legacy["positions_value"] == 4000.0


# ---------------------------------------------------------------------------
# legacy equivalence: update_equity / get_equity_curve
# ---------------------------------------------------------------------------

def test_update_equity_appends_record():
    pm = _make_manager()
    assert pm.update_equity(_golden_md(), timestamp="t0") is None
    assert len(pm.equity_history) == 1
    rec = pm.equity_history[0]
    assert rec == {
        "timestamp": "t0",
        "equity": 104000.0,
        "cash": 100000,
        "positions_value": 4000.0,
    }


def test_update_equity_matches_canonical_record():
    pm = _make_manager()
    md = _golden_md()
    pm.update_equity(md, timestamp="t0")
    canon = canonical.build_equity_record(pm.cash, pm.positions, md, timestamp="t0")
    assert pm.equity_history[0] == canon


def test_update_equity_repeated_and_history_preserved():
    pm = _make_manager()
    md = _golden_md()
    pm.update_equity(md, timestamp="t0")
    first_snapshot = dict(pm.equity_history[0])
    pm.update_equity(md, timestamp="t1")
    pm.update_equity(md, timestamp="t1")  # duplicate timestamp kept
    assert [r["timestamp"] for r in pm.equity_history] == ["t0", "t1", "t1"]
    # earlier entry unchanged after later updates
    assert pm.equity_history[0] == first_snapshot


def test_get_equity_curve_is_alias():
    pm = _make_manager()
    pm.update_equity(_golden_md(), timestamp="t0")
    curve = pm.get_equity_curve()
    assert curve is pm.equity_history
    pm.update_equity(_golden_md(), timestamp="t1")
    assert curve[-1]["timestamp"] == "t1"


# ---------------------------------------------------------------------------
# subclass compatibility
# ---------------------------------------------------------------------------

def test_subclass_inherits_state_methods():
    class MyPM(bha.PortfolioManager):
        def custom_method(self):
            return "ok"

    pm = MyPM(100000)
    pm.positions = {"AAPL": 10}
    pm.entry_prices = {"AAPL": 200.0}
    md = {"AAPL": _row(200.0)}

    state = pm.get_portfolio_state(md)
    assert state["positions_value"] == 2000.0
    pm.update_equity(md, timestamp="t0")
    assert pm.get_equity_curve()[0]["equity"] == 102000.0
    assert pm.custom_method() == "ok"


def test_class_locations_after_phase_2c5_move():
    # PortfolioManager (Phase 2C3) and HourlyBacktester (Phase 2C5) now both live
    # in the canonical backend package and are re-exported by the legacy script
    # (same object).
    from dashboard.backend.domain.backtesting.portfolio_manager import (
        PortfolioManager as CanonicalPortfolioManager,
    )
    from dashboard.backend.domain.backtesting.engine import (
        HourlyBacktester as CanonicalHourlyBacktester,
    )

    assert bha.PortfolioManager is CanonicalPortfolioManager
    assert bha.PortfolioManager.__module__ == (
        "dashboard.backend.domain.backtesting.portfolio_manager"
    )
    assert bha.HourlyBacktester is CanonicalHourlyBacktester
    assert bha.HourlyBacktester.__module__ == (
        "dashboard.backend.domain.backtesting.engine"
    )

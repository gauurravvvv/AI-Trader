"""Characterization tests for extracted backtest metrics (Phase 2A).

Locks in the current behavior of ``calculate_sharpe`` / ``calculate_max_drawdown``
and verifies the legacy ``HourlyBacktester._calc_*`` methods delegate to them.
Imports use the canonical package path.
"""

import pytest

from dashboard.backend.domain.backtesting.metrics import (
    calculate_max_drawdown,
    calculate_sharpe,
)
from dashboard.scripts import backtest_hourly_agent as bha


def _curve(values):
    return [{"equity": v} for v in values]


# --- calculate_sharpe ------------------------------------------------------

def test_sharpe_positive_returns_is_positive():
    assert calculate_sharpe(_curve([100000, 101000, 102500, 103200, 104500])) > 0


def test_sharpe_negative_returns_is_negative():
    assert calculate_sharpe(_curve([104500, 103200, 102500, 101000, 100000])) < 0


def test_sharpe_flat_curve_zero_volatility_is_zero():
    # zero standard deviation -> 0 (current behavior)
    assert calculate_sharpe(_curve([100000, 100000, 100000, 100000])) == 0


def test_sharpe_single_value_is_zero():
    assert calculate_sharpe(_curve([100000])) == 0


def test_sharpe_empty_is_zero():
    assert calculate_sharpe([]) == 0


# --- calculate_max_drawdown ------------------------------------------------

def test_max_drawdown_multiple_peaks():
    # 100 -> 120 (peak) -> 90 -> 130 (new peak) -> 80
    dd = calculate_max_drawdown(_curve([100, 120, 90, 130, 80]))
    assert dd == pytest.approx((80 - 130) / 130)


def test_max_drawdown_no_drawdown_is_zero():
    assert calculate_max_drawdown(_curve([100, 110, 120, 130])) == 0


def test_max_drawdown_empty_is_zero():
    assert calculate_max_drawdown([]) == 0


def test_max_drawdown_single_value_is_zero():
    assert calculate_max_drawdown(_curve([100])) == 0


def test_max_drawdown_is_nonpositive():
    assert calculate_max_drawdown(_curve([100, 50, 75, 40])) <= 0


# --- legacy delegation equivalence -----------------------------------------

@pytest.mark.parametrize(
    "values",
    [
        [100000, 101000, 99000, 102000, 98000],
        [100000, 100000, 100000],
        [100000],
        [],
        [100, 120, 90, 130, 80],
    ],
)
def test_legacy_methods_match_extracted(values):
    curve = _curve(values)
    assert bha.HourlyBacktester._calc_sharpe(curve) == calculate_sharpe(curve)
    assert bha.HourlyBacktester._calc_max_dd(curve) == calculate_max_drawdown(curve)

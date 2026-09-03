"""Backtest performance metrics.

Extracted (Phase 2A) from ``HourlyBacktester._calc_sharpe`` and
``HourlyBacktester._calc_max_dd`` in ``dashboard/scripts/backtest_hourly_agent.py``.

These are pure functions over an equity curve represented as a list of dicts,
each containing an ``"equity"`` value. Inputs, outputs, edge-case behavior, and
the hourly annualization assumptions are identical to the original methods; the
legacy methods now delegate here.
"""

from typing import Dict, List

import numpy as np


def calculate_sharpe(equity_curve: List[Dict]) -> float:
    """
    Calculate Sharpe ratio from hourly equity curve.

    Formula:
        sharpe = (mean(returns) / std(returns)) * sqrt(periods_per_year)

    Data is HOURLY, so annualization factor = sqrt(252 * 6.5):
        - 252 = trading days per year
        - 6.5 = trading hours per day (9:30 AM - 4:00 PM ET)
        - Total: sqrt(1638) ≈ 40.47

    Returns: float
        Annualized Sharpe ratio. Returns 0 if insufficient data or zero volatility.
    """
    if len(equity_curve) < 2:
        return 0

    equities = np.array([e["equity"] for e in equity_curve])
    returns = np.diff(equities) / equities[:-1]

    if len(returns) == 0 or np.std(returns) == 0:
        return 0

    # Annualize for hourly data: sqrt(252 trading days * 6.5 hours/day)
    annualization_factor = np.sqrt(252 * 6.5)
    return (np.mean(returns) / np.std(returns)) * annualization_factor


def calculate_max_drawdown(equity_curve: List[Dict]) -> float:
    """Calculate max drawdown."""
    if not equity_curve:
        return 0

    equities = np.array([e["equity"] for e in equity_curve])
    running_max = equities[0]
    max_dd = 0

    for equity in equities:
        if equity > running_max:
            running_max = equity
        dd = (equity - running_max) / running_max
        if dd < max_dd:
            max_dd = dd

    return max_dd

"""Compatibility tests for backtest_hourly_agent after Phase 2A extraction.

All imports use the canonical package path (never the flat ``backtest_hourly_agent``
module name). Verifies the script still exposes its public surface and that the
extracted symbols are the same objects the script now re-exports / delegates to.
"""

import pytest

from dashboard.backend.domain.backtesting.features import TechnicalIndicators
from dashboard.backend.domain.backtesting.metrics import (
    calculate_max_drawdown,
    calculate_sharpe,
)
from dashboard.backend.infrastructure.llm.decision_parsing import fix_json_formatting
from dashboard.scripts import backtest_hourly_agent as bha

PUBLIC_SURFACE = [
    "fix_json_formatting",
    "TechnicalIndicators",
    "PortfolioManager",
    "HourlyBacktester",
    "AlpacaDataLoader",
    "INITIAL_CAPITAL",
    "LLM_MODEL_NAME",
    "DJIA_30",
    "HAS_ANTHROPIC",
    "main",
]


@pytest.mark.parametrize("name", PUBLIC_SURFACE)
def test_public_symbol_present(name):
    assert hasattr(bha, name)


def test_anthropic_symbol_present_when_sdk_available():
    if bha.HAS_ANTHROPIC:
        assert hasattr(bha, "Anthropic")


def test_technical_indicators_is_extracted_class():
    assert bha.TechnicalIndicators is TechnicalIndicators


def test_fix_json_formatting_is_extracted_function():
    assert bha.fix_json_formatting is fix_json_formatting


def test_legacy_metric_methods_delegate():
    curve = [
        {"equity": 100000},
        {"equity": 99000},
        {"equity": 101000},
        {"equity": 98000},
    ]
    assert bha.HourlyBacktester._calc_sharpe(curve) == calculate_sharpe(curve)
    assert bha.HourlyBacktester._calc_max_dd(curve) == calculate_max_drawdown(curve)


def test_public_constants_unchanged():
    assert bha.INITIAL_CAPITAL == 1000
    assert isinstance(bha.DJIA_30, list)
    assert len(bha.DJIA_30) == 30

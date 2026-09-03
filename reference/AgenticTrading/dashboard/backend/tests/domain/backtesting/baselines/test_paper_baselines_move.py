"""Focused tests for the paper-trading baselines move (Phase 3C5B).

All Alpaca / market-data interactions are mocked: the module ``requests`` and the
broker client are replaced with fakes. No real network request occurs. Verifies
canonical imports, old-module re-export identity, calculator inputs/output
schemas, error propagation, runtime-consumer wiring, and import boundaries.
"""

import ast
from datetime import datetime
from pathlib import Path

import pytest

from dashboard.backend.domain.backtesting.baselines import paper as paper_mod
from dashboard.backend.domain.backtesting.baselines.paper import (
    DJIA_SYMBOLS,
    PaperTradingBaselineCalculator,
    create_paper_baselines_if_not_exists,
)

_BACKEND = Path(__file__).resolve().parents[4]


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeRequests:
    def __init__(self):
        self.calls = []
        self.responses = []
        self.default = _FakeResponse(200, {"bars": []})

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(
            {"url": url, "headers": headers, "params": params, "timeout": timeout}
        )
        if self.responses:
            return self.responses.pop(0)
        return self.default


@pytest.fixture
def fake_requests(monkeypatch):
    fake = _FakeRequests()
    monkeypatch.setattr(paper_mod, "requests", fake)
    return fake


@pytest.fixture
def calc():
    return PaperTradingBaselineCalculator(api_key="K", secret_key="S")


# ---------------------------------------------------------------------------
# Canonical surface
# ---------------------------------------------------------------------------

def test_djia_symbols_track_canonical():
    from dashboard.backend.infrastructure.llm.validator import DJIA_30
    assert DJIA_SYMBOLS == list(DJIA_30)
    assert len(DJIA_SYMBOLS) == 30


# ---------------------------------------------------------------------------
# Calculator construction
# ---------------------------------------------------------------------------

def test_calculator_explicit_credentials_and_url():
    c = PaperTradingBaselineCalculator(api_key="abc", secret_key="def")
    assert c.api_key == "abc"
    assert c.secret_key == "def"
    assert c.data_api_url == "https://data.alpaca.markets"
    assert c.headers == {
        "APCA-API-KEY-ID": "abc",
        "APCA-API-SECRET-KEY": "def",
    }


# ---------------------------------------------------------------------------
# DJIA historical (SPY proxy)
# ---------------------------------------------------------------------------

def test_fetch_djia_historical_schema(calc, fake_requests):
    fake_requests.responses = [
        _FakeResponse(200, {"bars": [
            {"t": "2024-01-01", "c": 100.0},
            {"t": "2024-01-02", "c": 110.0},
        ]})
    ]
    curve = calc.fetch_djia_historical(datetime(2024, 1, 1), datetime(2024, 1, 2))

    call = fake_requests.calls[0]
    assert call["url"] == "https://data.alpaca.markets/v2/stocks/SPY/bars"
    assert call["params"] == {"start": "2024-01-01", "end": "2024-01-02", "timeframe": "1D"}
    assert call["timeout"] == 10

    assert len(curve) == 2
    assert curve[0] == {
        "timestamp": "2024-01-01",
        "equity": 1000.0,
        "cash": 300.0,
        "positions_value": 700.0,
        "daily_return": 0.0,
    }
    assert curve[1]["equity"] == 1100.0
    assert round(curve[1]["daily_return"], 4) == 0.1


def test_fetch_djia_historical_non_200_returns_none(calc, fake_requests):
    fake_requests.responses = [_FakeResponse(500, None)]
    assert calc.fetch_djia_historical(datetime(2024, 1, 1), datetime(2024, 1, 2)) is None


def test_fetch_djia_historical_empty_bars_returns_none(calc, fake_requests):
    fake_requests.responses = [_FakeResponse(200, {"bars": []})]
    assert calc.fetch_djia_historical(datetime(2024, 1, 1), datetime(2024, 1, 2)) is None


# ---------------------------------------------------------------------------
# Buy-and-hold DJIA
# ---------------------------------------------------------------------------

def test_fetch_buy_and_hold_schema(calc, fake_requests):
    # 10 symbols requested (the canonical TOP_10_STOCKS basket); each returns 2 bars.
    fake_requests.responses = [
        _FakeResponse(200, {"bars": [
            {"t": "2024-01-01", "c": 10.0},
            {"t": "2024-01-02", "c": 11.0},
        ]})
        for _ in range(10)
    ]
    curve = calc.fetch_buy_and_hold_djia(datetime(2024, 1, 1), datetime(2024, 1, 2))

    assert len(fake_requests.calls) == 10
    first_call = fake_requests.calls[0]
    assert first_call["url"] == "https://data.alpaca.markets/v2/stocks/AAPL/bars"
    assert first_call["timeout"] == 5

    assert len(curve) == 2
    assert curve[0]["equity"] == 1000.0
    assert curve[0]["daily_return"] == 0.0
    # Each symbol up 10% -> avg return 0.1 -> equity 1100.
    assert curve[1]["equity"] == 1100.0
    assert round(curve[1]["daily_return"], 4) == 0.1


def test_fetch_buy_and_hold_no_data_returns_none(calc, fake_requests):
    fake_requests.responses = [_FakeResponse(500, None) for _ in range(10)]
    assert calc.fetch_buy_and_hold_djia(datetime(2024, 1, 1), datetime(2024, 1, 2)) is None


# ---------------------------------------------------------------------------
# Paper account date range (broker history mocked)
# ---------------------------------------------------------------------------

def test_get_paper_account_date_range_no_credentials_returns_none():
    c = PaperTradingBaselineCalculator(api_key="", secret_key="")
    # Empty credentials -> short-circuits before any provider call.
    assert c.get_paper_account_date_range() is None


def test_get_paper_account_date_range_uses_broker(calc, monkeypatch):
    captured = {}

    class _FakeClient:
        def __init__(self, api_key, secret_key):
            captured["creds"] = (api_key, secret_key)

        def get_portfolio_history(self, timeframe="1D"):
            captured["timeframe"] = timeframe
            return {"timestamp": [1_700_000_000, 1_700_086_400]}

    monkeypatch.setattr(paper_mod, "AlpacaPaperTradingClient", _FakeClient)
    result = calc.get_paper_account_date_range()

    assert captured["creds"] == ("K", "S")
    assert captured["timeframe"] == "1D"
    assert result is not None
    start, end = result
    assert isinstance(start, datetime)
    assert isinstance(end, datetime)


def test_get_paper_account_date_range_broker_error_returns_none(calc, monkeypatch):
    class _BoomClient:
        def __init__(self, *a, **k):
            pass

        def get_portfolio_history(self, timeframe="1D"):
            raise RuntimeError("boom")

    monkeypatch.setattr(paper_mod, "AlpacaPaperTradingClient", _BoomClient)
    assert calc.get_paper_account_date_range() is None


# ---------------------------------------------------------------------------
# Entrypoint helper (db mocked)
# ---------------------------------------------------------------------------

def test_create_if_not_exists_skips_when_baselines_present(monkeypatch):
    class _FakeDB:
        def get_runs_by_mode(self, mode):
            assert mode == "paper_baseline"
            return [object(), object()]

    monkeypatch.setattr(paper_mod, "db", _FakeDB())
    assert create_paper_baselines_if_not_exists() is True


def test_create_if_not_exists_swallows_errors(monkeypatch):
    class _FakeDB:
        def get_runs_by_mode(self, mode):
            raise RuntimeError("db down")

    monkeypatch.setattr(paper_mod, "db", _FakeDB())
    assert create_paper_baselines_if_not_exists() is False


# ---------------------------------------------------------------------------
# Runtime consumer + import boundaries
# ---------------------------------------------------------------------------

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


def test_app_uses_canonical_baselines():
    mods = _imported_modules(_BACKEND / "app.py")
    assert "dashboard.backend.domain.backtesting.baselines.paper" in mods


def test_baselines_module_uses_canonical_broker_adapter():
    mods = _imported_modules(
        _BACKEND / "domain" / "backtesting" / "baselines" / "paper.py"
    )
    assert "dashboard.backend.infrastructure.brokers.alpaca_paper" in mods


def test_baselines_module_has_no_api_or_scripts_imports():
    mods = _imported_modules(
        _BACKEND / "domain" / "backtesting" / "baselines" / "paper.py"
    )
    for m in mods:
        assert not m.startswith("dashboard.backend.api"), m
        assert not m.startswith("dashboard.scripts"), m

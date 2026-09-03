"""Characterization tests for the market-data quotes provider (Phase 3D1).

All external interactions are mocked: the module ``requests`` is replaced with a
fake, and ``yfinance`` is injected as a fake module. No real network request
occurs. Imports use the canonical package path.
"""

import ast
import sys
import types
from pathlib import Path

import pytest

from dashboard.backend.infrastructure.market_data import quotes as quotes_mod
from dashboard.backend.infrastructure.market_data.quotes import (
    AlpacaMarketData,
    _extract_prev_close_from_bars,
    _extract_price_from_quote,
    get_market_quotes,
    get_yahoo_quotes_batch,
)

_BACKEND = Path(__file__).resolve().parents[3]


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


class _FakeRequests:
    def __init__(self):
        self.calls = []
        self.responses = []
        self.default = _FakeResponse(200, {})

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
    monkeypatch.setattr(quotes_mod, "requests", fake)
    return fake


@pytest.fixture
def md():
    return AlpacaMarketData(api_key="K", secret_key="S")


@pytest.fixture(autouse=True)
def _clear_cache():
    quotes_mod._ticker_cache.clear()
    yield
    quotes_mod._ticker_cache.clear()


# ---------------------------------------------------------------------------
# Pure parsing helpers
# ---------------------------------------------------------------------------

def test_extract_price_midpoint():
    assert _extract_price_from_quote({"ap": "10", "bp": "8"}) == 9.0


def test_extract_price_prefers_ask_then_bid_then_last():
    assert _extract_price_from_quote({"ap": "10"}) == 10.0
    assert _extract_price_from_quote({"bp": "7"}) == 7.0
    assert _extract_price_from_quote({"p": "5"}) == 5.0
    assert _extract_price_from_quote({}) is None


def test_extract_prev_close_uses_second_most_recent():
    bars = [
        {"t": "2024-01-03", "c": "30"},
        {"t": "2024-01-02", "c": "20"},
        {"t": "2024-01-01", "c": "10"},
    ]
    assert _extract_prev_close_from_bars(bars) == 20.0


def test_extract_prev_close_empty():
    assert _extract_prev_close_from_bars([]) is None


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

def test_construction_urls_and_headers():
    c = AlpacaMarketData(api_key="abc", secret_key="def")
    assert c.base_url == "https://paper-api.alpaca.markets"
    assert c.data_api_url == "https://data.alpaca.markets"
    assert c.headers == {"APCA-API-KEY-ID": "abc", "APCA-API-SECRET-KEY": "def"}


def test_construction_live_base_url():
    c = AlpacaMarketData(api_key="abc", secret_key="def", paper=False)
    assert c.base_url == "https://api.alpaca.markets"


# ---------------------------------------------------------------------------
# get_quote
# ---------------------------------------------------------------------------

def test_get_quote_request_and_schema(md, fake_requests, monkeypatch):
    fake_requests.responses = [
        _FakeResponse(200, {"quote": {"ap": "10", "bp": "8", "t": "ts"}})
    ]
    monkeypatch.setattr(AlpacaMarketData, "_get_previous_close", lambda self, s: 9.0)

    result = md.get_quote("AAPL")

    call = fake_requests.calls[0]
    assert call["url"] == "https://data.alpaca.markets/v2/stocks/AAPL/quotes/latest"
    assert call["headers"] == md.headers
    assert call["timeout"] == 5

    assert result["symbol"] == "AAPL"
    assert result["price"] == 9.0
    assert result["changePercent"] == 0.0
    assert "timestamp" in result


def test_get_quote_no_prev_close_changepercent_none(md, fake_requests, monkeypatch):
    fake_requests.responses = [_FakeResponse(200, {"quote": {"ap": "10", "bp": "8"}})]
    monkeypatch.setattr(AlpacaMarketData, "_get_previous_close", lambda self, s: None)
    result = md.get_quote("AAPL")
    assert result["price"] == 9.0
    assert result["changePercent"] is None


def test_get_quote_non_200_returns_none(md, fake_requests):
    fake_requests.responses = [_FakeResponse(500, None, text="err")]
    assert md.get_quote("AAPL") is None


# ---------------------------------------------------------------------------
# Batch endpoints
# ---------------------------------------------------------------------------

def test_get_latest_quotes_batch(md, fake_requests):
    fake_requests.responses = [
        _FakeResponse(200, {"quotes": {"AAPL": {"ap": "10", "bp": "8"}}})
    ]
    prices = md.get_latest_quotes_batch(["AAPL"])
    call = fake_requests.calls[0]
    assert call["url"] == (
        "https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=AAPL&feed=iex"
    )
    assert call["timeout"] == 10
    assert prices == {"AAPL": 9.0}


def test_get_latest_quotes_batch_empty_short_circuits(md, fake_requests):
    assert md.get_latest_quotes_batch([]) == {}
    assert fake_requests.calls == []


def test_get_previous_closes_batch(md, fake_requests):
    fake_requests.responses = [
        _FakeResponse(200, {"bars": {"AAPL": [
            {"t": "2024-01-02", "c": "20"},
            {"t": "2024-01-01", "c": "10"},
        ]}})
    ]
    closes = md.get_previous_closes_batch(["AAPL"])
    call = fake_requests.calls[0]
    assert "/v2/stocks/bars" in call["url"]
    assert "feed=iex" in call["url"]
    assert call["timeout"] == 10
    # Helper picks the 2nd-most-recent completed bar (the older of the two).
    assert closes == {"AAPL": 10.0}


def test_get_quotes_batch_combines(md, monkeypatch):
    monkeypatch.setattr(md, "get_latest_quotes_batch", lambda s: {"AAPL": 100.0})
    monkeypatch.setattr(md, "get_previous_closes_batch", lambda s: {"AAPL": 80.0})
    quotes = md.get_quotes_batch(["AAPL"])
    assert quotes == [{
        "symbol": "AAPL",
        "price": 100.0,
        "changePercent": 25.0,
        "timestamp": quotes[0]["timestamp"],
    }]


# ---------------------------------------------------------------------------
# Crypto (CoinGecko)
# ---------------------------------------------------------------------------

def test_get_crypto_quote_schema(md, fake_requests):
    fake_requests.responses = [
        _FakeResponse(200, {"bitcoin": {"usd": 65000.0, "usd_24h_change": 2.5}})
    ]
    result = md.get_crypto_quote("BTC")
    call = fake_requests.calls[0]
    assert "api.coingecko.com" in call["url"]
    assert "bitcoin" in call["url"]
    assert call["timeout"] == 5
    assert result["symbol"] == "BTC"
    assert result["price"] == "65.00k"
    assert result["changePercent"] == 2.5


def test_get_crypto_quote_unsupported_symbol(md, fake_requests):
    assert md.get_crypto_quote("DOGE") is None
    assert fake_requests.calls == []


# ---------------------------------------------------------------------------
# Yahoo provider (yfinance injected)
# ---------------------------------------------------------------------------

class _FastInfo:
    def __init__(self, last_price, previous_close):
        self.last_price = last_price
        self.previous_close = previous_close

    def get(self, key):  # not used when attributes present
        return None


class _FakeTicker:
    def __init__(self, fast):
        self.fast_info = fast


class _FakeTickers:
    def __init__(self, mapping):
        self.tickers = mapping


def _install_fake_yfinance(monkeypatch, tickers_map):
    fake = types.ModuleType("yfinance")
    fake.Tickers = lambda s: _FakeTickers(tickers_map)
    fake.download = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "yfinance", fake)
    return fake


def test_get_yahoo_quotes_batch_happy_path(monkeypatch):
    tickers = {"AAPL": _FakeTicker(_FastInfo(150.0, 100.0))}
    _install_fake_yfinance(monkeypatch, tickers)
    result = get_yahoo_quotes_batch(["AAPL"])
    assert len(result) == 1
    assert result[0]["symbol"] == "AAPL"
    assert result[0]["price"] == 150.0
    assert result[0]["changePercent"] == 50.0


def test_get_yahoo_quotes_batch_empty():
    assert get_yahoo_quotes_batch([]) == []


def test_get_yahoo_quotes_batch_missing_yfinance(monkeypatch):
    # Simulate yfinance not installed.
    monkeypatch.setitem(sys.modules, "yfinance", None)
    assert get_yahoo_quotes_batch(["AAPL"]) == []


# ---------------------------------------------------------------------------
# get_market_quotes orchestration + cache
# ---------------------------------------------------------------------------

def test_get_market_quotes_uses_yahoo_then_caches(monkeypatch):
    calls = {"n": 0}

    def fake_yahoo(symbols):
        calls["n"] += 1
        return [{"symbol": s, "price": 1.0, "changePercent": None, "timestamp": "t"} for s in symbols]

    monkeypatch.setattr(quotes_mod, "get_yahoo_quotes_batch", fake_yahoo)
    result1 = get_market_quotes(["AAPL", "MSFT"])
    assert {q["symbol"] for q in result1} == {"AAPL", "MSFT"}
    assert calls["n"] == 1

    # Second call within TTL hits cache -> yahoo not called again.
    result2 = get_market_quotes(["AAPL", "MSFT"])
    assert result2 == result1
    assert calls["n"] == 1


def test_get_market_quotes_crypto_path(monkeypatch):
    class _FakeMD:
        def __init__(self, *a, **k):
            pass

        def get_crypto_quote(self, symbol):
            return {"symbol": symbol, "price": "65.00k", "changePercent": 1.0, "timestamp": "t"}

    monkeypatch.setattr(quotes_mod, "AlpacaMarketData", _FakeMD)
    result = get_market_quotes(["BTC"])
    assert result == [{"symbol": "BTC", "price": "65.00k", "changePercent": 1.0, "timestamp": "t"}]


# ---------------------------------------------------------------------------
# Boundaries
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


def test_app_uses_canonical_quotes_import():
    # Phase 3D4A: the /ticker route (the runtime consumer of get_market_quotes)
    # moved out of app.py into the canonical market router.
    mods = _imported_modules(_BACKEND / "api" / "routers" / "market.py")
    assert "dashboard.backend.infrastructure.market_data.quotes" in mods


def test_quotes_module_has_no_api_or_scripts_imports():
    mods = _imported_modules(
        _BACKEND / "infrastructure" / "market_data" / "quotes.py"
    )
    for m in mods:
        assert not m.startswith("dashboard.backend.api"), m
        assert not m.startswith("dashboard.scripts"), m


# ---------------------------------------------------------------------------
# Symbol validation (CodeQL py/partial-ssrf #48–#50). ``symbol`` arrives from
# ``/ticker?symbols=`` and is interpolated into the Alpaca URL path, so a
# crafted "symbol" could steer the request to a different endpoint under the
# server's API key. URL-breaking symbols must be rejected before any request.
# ---------------------------------------------------------------------------


def test_get_quote_rejects_url_breaking_symbols(md, fake_requests):
    assert md.get_quote("../../v1/account") is None
    assert md.get_quote("AAPL?feed=sip") is None
    assert md.get_quote("AAPL#frag") is None
    assert md.get_quote("") is None
    assert fake_requests.calls == []


def test_prev_close_rejects_url_breaking_symbols(md, fake_requests):
    assert md._get_previous_close("../../v1/account") is None
    assert fake_requests.calls == []


def test_get_quote_still_requests_dotted_and_hyphenated_tickers(md, fake_requests):
    # Real ticker classes the allowlist must not break (BRK.B, BF-B style).
    md.get_quote("BRK.B")
    md.get_quote("BF-B")
    assert len(fake_requests.calls) >= 2

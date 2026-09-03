from fastapi.testclient import TestClient

from dashboard.backend.app import app
from dashboard.backend import cache as cache_mod
from dashboard.backend.integrations import news_sentiment as ns


def test_news_signals_route_returns_payload(monkeypatch):
    cache_mod.shared_ttl_cache.invalidate(cache_mod.CACHE_KEY_NEWS_SIGNALS)
    fake = {"status": "ok", "status_reason": None, "generated_at": "2026-07-13T11:20:00+00:00",
            "staleness_hours": 1.2, "news_overview": "calm", "signals": {}, "feed": []}
    monkeypatch.setattr(ns, "get_latest_panel_payload", lambda tickers: fake)
    client = TestClient(app)
    resp = client.get("/api/news/signals")
    assert resp.status_code == 200
    assert resp.json()["news_overview"] == "calm"


def test_news_signals_route_fail_closed(monkeypatch):
    cache_mod.shared_ttl_cache.invalidate(cache_mod.CACHE_KEY_NEWS_SIGNALS)
    def _boom(tickers):
        raise RuntimeError("adapter exploded")
    monkeypatch.setattr(ns, "get_latest_panel_payload", _boom)
    client = TestClient(app)
    resp = client.get("/api/news/signals")
    assert resp.status_code == 200
    assert resp.json()["status"] == "unavailable"


def test_news_signals_route_caches(monkeypatch):
    cache_mod.shared_ttl_cache.invalidate(cache_mod.CACHE_KEY_NEWS_SIGNALS)
    calls = []
    def _once(tickers):
        calls.append(1)
        return {"status": "ok", "status_reason": None, "generated_at": None,
                "staleness_hours": None, "news_overview": None, "signals": {}, "feed": []}
    monkeypatch.setattr(ns, "get_latest_panel_payload", _once)
    client = TestClient(app)
    client.get("/api/news/signals")
    client.get("/api/news/signals")
    assert len(calls) == 1


def test_news_signals_route_negative_caches_failures(monkeypatch):
    """The whole point of the short-TTL negative cache: a second failing request
    within TTL_NEWS_UNAVAILABLE is served from cache, NOT re-run through the ~10s
    adapter behind _fetch_lock (the outage-serialization fix). Without the negative
    cache this asserts len(calls) == 2 — the regression the fix prevents."""
    cache_mod.shared_ttl_cache.invalidate(cache_mod.CACHE_KEY_NEWS_SIGNALS)
    calls = []
    def _boom(tickers):
        calls.append(1)
        raise RuntimeError("adapter exploded")
    monkeypatch.setattr(ns, "get_latest_panel_payload", _boom)
    client = TestClient(app)
    assert client.get("/api/news/signals").json()["status"] == "unavailable"
    assert client.get("/api/news/signals").json()["status"] == "unavailable"
    assert len(calls) == 1  # second request served from the negative cache

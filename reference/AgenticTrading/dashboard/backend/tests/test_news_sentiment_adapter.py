import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from dashboard.backend.integrations import news_sentiment as ns
from dashboard.backend.tests.test_news_sentiment_fixture import (
    load_items_wire_fixture,
    load_signals_fixture,
    load_signals_wire_fixture,
)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    ns.clear_cache()
    # Default the items endpoint to a fast 404 ("no items yet") so pre-Phase-B
    # tests that only mock ns._http_get keep exercising Phase-A behavior
    # (representative feed) instead of silently hitting the real network via
    # get_latest_panel_payload's new fetch_items() call. Phase-B tests below
    # override this per-test.
    monkeypatch.setattr(ns, "_http_get_items",
                         lambda **kw: _fake_response(status=404, body={"error": "no_items"}))
    yield
    ns.clear_cache()


def _fake_response(status=200, body=None, etag='"e1"'):
    return SimpleNamespace(
        status_code=status,
        headers={"ETag": etag},
        json=lambda: body if body is not None else load_signals_fixture(),
    )


def test_projection_maps_all_fields_including_rationale(monkeypatch):
    body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    ts = datetime(2026, 7, 10, 15, 0, tzinfo=timezone.utc)
    out = ns.get_news_sentiment(["MSFT", "AAPL"], ts)
    sym, src = next(iter(body["signals"].items()))
    entry = out["news_sentiment"].get(sym)
    if entry is not None:  # fixture symbol may not be in the passed universe filter
        assert entry["sentiment"] == src["sentiment"]
        assert entry["rationale"] == src["rationale"]
        assert entry["age_hours"] >= 0.0
    assert out["news_overview"] == body["news_overview"]


def test_age_hours_referenced_to_step_timestamp_not_wallclock(monkeypatch):
    body = load_signals_fixture()
    sym = next(iter(body["signals"]))
    published = body["signals"][sym]["published"]
    step_ts = datetime.fromtimestamp(published + 7200, tz=timezone.utc)  # 2h later
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    out = ns.get_news_sentiment([sym], step_ts)
    assert abs(out["news_sentiment"][sym]["age_hours"] - 2.0) < 0.01


def test_404_is_quiet_empty(monkeypatch):
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(status=404, body={}))
    out = ns.get_news_sentiment(["MSFT"], datetime.now(timezone.utc))
    assert out == {"news_sentiment": {}, "news_overview": None}


def test_401_is_empty_and_logs_error(monkeypatch, caplog):
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(status=401, body={}))
    with caplog.at_level("ERROR"):
        out = ns.get_news_sentiment(["MSFT"], datetime.now(timezone.utc))
    assert out["news_sentiment"] == {}
    assert any("FINGPT_API_KEY" in r.message for r in caplog.records)


def test_network_error_fails_closed_never_stale(monkeypatch):
    """A transport failure returns unavailable — it must NOT serve the
    previously cached body for the same key (stale data presented as fresh
    during an outage)."""
    body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    warm = ns.get_latest_panel_payload(["MSFT"])  # warms the ("", tickers) key
    assert warm["status"] != "unavailable"

    def _boom(**kw):
        raise OSError("connection refused")
    monkeypatch.setattr(ns, "_http_get", _boom)
    out = ns.get_latest_panel_payload(["MSFT"])  # same key, latest path revalidates
    assert out["status"] == "unavailable"


def test_real_call_site_passes_iso_string(monkeypatch):
    """The v2 step envelope serializes timestamp to an ISO STRING
    (external_run_service.py:429-431) — the adapter must parse it, not crash
    into the fail-closed loader."""
    body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    out = ns.get_news_sentiment(["MSFT"], "2026-07-10T15:00:00+00:00")
    assert out["news_overview"] == body["news_overview"]  # parsed, not swallowed


def test_garbage_timestamp_fails_closed(monkeypatch):
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response())
    out = ns.get_news_sentiment(["MSFT"], "not-a-date")
    assert out == {"news_sentiment": {}, "news_overview": None}


def test_past_as_of_memoized_one_call(monkeypatch):
    calls = []
    def _counting(**kw):
        calls.append(kw)
        return _fake_response()
    monkeypatch.setattr(ns, "_http_get", _counting)
    ts = datetime(2026, 7, 10, 15, 0, tzinfo=timezone.utc)  # strictly past date
    ns.get_news_sentiment(["MSFT"], ts)
    ns.get_news_sentiment(["MSFT"], ts.replace(hour=16))  # same date -> same as_of
    assert len(calls) == 1


def test_config_error_negative_cached_for_past_dates(monkeypatch):
    """A 401 must not turn a 161-step backtest into 161 live calls."""
    calls = []
    def _unauth(**kw):
        calls.append(1)
        return _fake_response(status=401, body={})
    monkeypatch.setattr(ns, "_http_get", _unauth)
    ts = datetime(2026, 7, 1, 15, 0, tzinfo=timezone.utc)
    ns.get_news_sentiment(["MSFT"], ts)
    ns.get_news_sentiment(["MSFT"], ts)
    assert len(calls) == 1


def test_past_transport_failure_negative_cached_one_call(monkeypatch):
    """A network outage on an immutable PAST date is memoized as an honest gap —
    otherwise a 161-step backtest pays 161 live timeouts (the fix's whole point).
    Distinct from test_config_error_negative_cached_for_past_dates, which covers
    an HTTP 401; this covers a transport-layer failure (no response at all)."""
    calls = []
    def _boom(**kw):
        calls.append(1)
        raise OSError("connection refused")
    monkeypatch.setattr(ns, "_http_get", _boom)
    ts = datetime(2026, 7, 1, 15, 0, tzinfo=timezone.utc)  # strictly past
    first = ns.get_news_sentiment(["MSFT"], ts)
    second = ns.get_news_sentiment(["MSFT"], ts)
    assert first == {"news_sentiment": {}, "news_overview": None}
    assert second == {"news_sentiment": {}, "news_overview": None}
    assert len(calls) == 1  # gap memoized; no second live timeout


def test_today_outage_throttled_then_reattempts(monkeypatch):
    """A today/latest OUTAGE is negative-cached briefly so it doesn't re-hit the
    producer on every poll, then re-attempts once the window elapses."""
    calls = []
    def _boom(**kw):
        calls.append(1)
        raise OSError("down")
    monkeypatch.setattr(ns, "_http_get", _boom)
    now = datetime.now(timezone.utc)
    ns.get_news_sentiment(["MSFT"], now)
    ns.get_news_sentiment(["MSFT"], now)
    assert len(calls) == 1  # second served from the short negative cache
    # Expire the throttle entry (white-box, avoids a sleep) -> next call re-hits.
    with ns._lock:
        for entry in ns._CACHE.values():
            if entry["expires_at"] is not None:
                entry["expires_at"] = time.monotonic() - 1
    ns.get_news_sentiment(["MSFT"], now)
    assert len(calls) == 2


def test_malformed_panel_signal_dropped_not_whole_panel(monkeypatch):
    """One signal missing a required story field is dropped from the feed
    (logged), not allowed to collapse the entire panel to unavailable."""
    body = load_signals_fixture()
    # Off-spec in exactly one way — no headline/url — so the drop is
    # attributable to the missing story field. Keep sentiment_score valid:
    # omitting it too would drop the entry for a second, unrelated reason and
    # this test would pass without proving what it claims.
    body["signals"]["BADD"] = {"sentiment": "bullish", "sentiment_score": 0.1}
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA", "BADD"])
    assert payload["status"] != "unavailable"                 # panel survived
    feed_tickers = {item["ticker"] for item in payload["feed"]}
    assert "MSFT" in feed_tickers and "BADD" not in feed_tickers  # good kept, bad dropped
    # BADD has no url/source either, so it is unrenderable in the signals list
    # too. Asserted separately from the feed: they are independent projections
    # with different required keys, and this test used to check only the feed —
    # which is precisely how the raw `signals` passthrough went unguarded.
    assert "BADD" not in payload["signals"]
    assert {"MSFT", "NVDA"} <= set(payload["signals"])


def test_panel_signal_missing_sentiment_score_is_dropped_not_rendered_nan(monkeypatch):
    """The bug this guard exists for. `signals` was passed through raw, so a
    renamed `sentiment_score` reached the browser intact and
    `Number(undefined).toFixed(2)` painted the literal string "NaN" into every
    chip — no drop, no exception, no alarm. Drop the entry instead: a missing
    reading must not render as a reading."""
    body = load_signals_fixture()
    del body["signals"]["NVDA"]["sentiment_score"]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert "NVDA" not in payload["signals"]
    assert "MSFT" in payload["signals"]
    assert payload["status"] != "unavailable"      # one bad entry != an outage
    # Still a valid story, so it stays in the feed: the two projections have
    # independent required keys and must not be coupled.
    assert any(item["ticker"] == "NVDA" for item in payload["feed"])


@pytest.mark.parametrize("missing_key", ["sentiment", "sentiment_score", "url", "source"])
def test_panel_signal_missing_any_rendering_key_is_dropped(monkeypatch, missing_key):
    """Pins every key in _PANEL_SIGNAL_KEYS individually, one case each.

    Without this, only `sentiment_score` was actually pinned: deleting
    `sentiment`, `url` or `source` from the guard left the whole suite green.
    A guard for renamed fields whose own key set is unpinned against renaming
    is the same bug one level up — so each key gets its own failing case."""
    body = load_signals_fixture()
    del body["signals"]["NVDA"][missing_key]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert "NVDA" not in payload["signals"]
    assert "MSFT" in payload["signals"]


# `None`/`42` specifically, NOT a str or list: those are containers, so
# `"sentiment" not in "not-a-dict"` quietly substring-matches and the entry is
# dropped by the missing-key branch whether or not the isinstance guard exists
# — a test using one passes with the guard deleted and proves nothing.
@pytest.mark.parametrize("bad_entry", [None, 42])
def test_panel_signal_that_is_not_an_object_is_dropped_not_fatal(monkeypatch, bad_entry):
    """A non-dict entry must degrade to a per-entry drop, not a TypeError out
    of the `k not in s` membership test that takes the whole panel down with
    it. Unreachable while the producer honours its schema — which is exactly
    why it needs a test rather than trust."""
    body = load_signals_fixture()
    body["signals"]["WEIRD"] = bad_entry
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA", "WEIRD"])
    assert "WEIRD" not in payload["signals"]
    assert {"MSFT", "NVDA"} <= set(payload["signals"])
    assert payload["status"] != "unavailable"   # one bad entry != an outage


def test_panel_signals_all_missing_sentiment_score_surfaces_as_degraded(monkeypatch):
    """Wholesale drift, i.e. a producer rename rather than one off-spec entry.
    The feed is unaffected (it reads headline/url/source), so without an alarm
    on the signals projection the panel would look healthy while every
    directional read silently vanished."""
    body = load_signals_fixture()
    for sig in body["signals"].values():
        del sig["sentiment_score"]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert payload["signals"] == {}
    assert payload["status"] == "degraded"
    assert ns._DRIFT_STATUS_REASON in payload["status_reason"]
    assert payload["feed"]  # the feed still renders — this is signals-only drift


def test_panel_signals_drift_survives_a_healthy_items_feed(monkeypatch):
    """Pins the `drifted` accumulation, which is sharper than it looks: the
    items alarm ASSIGNS `drifted` rather than OR-ing it, so a signals-drift
    result seeded anywhere above that line is clobbered on exactly the requests
    where the items feed loads — the healthy Phase-B case, i.e. always, in
    prod. The guard would read correctly and fire never. The other drift tests
    can't see this: they leave `_http_get_items` unpatched, so items never
    load and the clobbering line never runs."""
    signals_body = load_signals_fixture()
    items_body = load_items_wire_fixture()
    for sig in signals_body["signals"].values():
        del sig["sentiment_score"]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body=items_body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert payload["signals"] == {}
    assert payload["feed"]                    # Phase B healthy — no feed drift
    assert payload["status"] == "degraded"    # ...and the signals drift still lands
    assert ns._DRIFT_STATUS_REASON in payload["status_reason"]


def test_panel_signal_with_null_published_sinks_not_crashes(monkeypatch):
    """An off-spec `published: null` must not throw inside the feed sort and
    collapse the panel — the item sinks to the bottom instead."""
    body = load_signals_fixture()
    body["signals"]["MSFT"]["published"] = None
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert payload["status"] != "unavailable"
    assert any(item["ticker"] == "MSFT" for item in payload["feed"])  # sunk, not dropped


def test_single_flight_follower_neither_hits_producer_nor_blocks(monkeypatch):
    """Two concurrent callers on the same cold key: exactly one leader hits the
    producer; the follower returns WITHOUT a second call and WITHOUT blocking
    behind the leader's ~10s upstream call (the threadpool-starvation fix)."""
    import threading as _threading
    body = load_signals_fixture()
    started, release, calls = _threading.Event(), _threading.Event(), []

    def _slow(**kw):
        calls.append(1)
        started.set()          # leader is now inside the producer call
        release.wait(2.0)      # hold until the follower has raced in
        return _fake_response(body=body)

    monkeypatch.setattr(ns, "_http_get", _slow)
    results = {}
    leader = _threading.Thread(
        target=lambda: results.__setitem__("leader", ns.get_latest_panel_payload(["MSFT"])))
    leader.start()
    assert started.wait(2.0)   # leader is mid-fetch, holding _inflight
    follower = _threading.Thread(
        target=lambda: results.__setitem__("follower", ns.get_latest_panel_payload(["MSFT"])))
    follower.start()
    follower.join(2.0)
    assert not follower.is_alive()                          # did not block behind the leader
    assert results["follower"]["status"] == "unavailable"   # cold start: no body yet
    release.set()
    leader.join(2.0)
    assert results["leader"]["status"] != "unavailable"     # leader got real data
    assert len(calls) == 1                                  # follower never hit the producer


def test_todays_404_not_hard_memoized(monkeypatch):
    """A 404 seen before the daily heartbeat lands must not stick for the
    process lifetime — today's key always revalidates."""
    responses = [_fake_response(status=404, body={}), _fake_response()]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: responses.pop(0))
    now = datetime.now(timezone.utc)
    first = ns.get_news_sentiment(["MSFT"], now)
    second = ns.get_news_sentiment(["MSFT"], now)
    assert first["news_sentiment"] == {}
    assert second["news_overview"] is not None


def test_panel_payload_shapes_feed_and_signals(monkeypatch):
    body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["status"] in ("ok", "degraded")
    assert payload["news_overview"] == body["news_overview"]
    assert set(payload["signals"]) <= set(body["signals"])
    pubs = [item["published"] for item in payload["feed"]]
    assert pubs == sorted(pubs, reverse=True)
    for item in payload["feed"]:
        assert item["url"] and item["headline"] and item["source"]


def test_panel_payload_unavailable_on_failure(monkeypatch):
    def _boom(**kw):
        raise OSError("down")
    monkeypatch.setattr(ns, "_http_get", _boom)
    payload = ns.get_latest_panel_payload(["MSFT"])
    assert payload == ns.UNAVAILABLE_PAYLOAD  # single-sourced shape (router reuses it)


# --- Live wire-shape coverage (staleness_hours / degraded / 304) --------------
# The vendored on-disk fixture omits `staleness_hours` and is `status: ok`, so
# these branches are only reachable through the stripped-and-injected wire shape
# (contract §"Producer response shape"). See signals-wire-fixture.json.


def test_wire_shape_passes_staleness_hours_through(monkeypatch):
    """The panel surfaces the server-injected `staleness_hours` verbatim — the
    documented origin of the "Updated Xh ago" header. Unreachable via the
    on-disk fixture, which has no such key."""
    body = load_signals_wire_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert payload["staleness_hours"] == body["staleness_hours"]
    assert payload["staleness_hours"] is not None  # the whole point vs on-disk fixture


def test_degraded_artifact_is_usable_projected_and_logged(monkeypatch, caplog):
    """A `degraded` artifact is still usable (contract §"Error & degraded
    handling"): the panel projects its signals and passes status/status_reason
    through, and the adapter logs the reason so the run stays auditable."""
    body = dict(load_signals_wire_fixture())
    body["status"] = "degraded"
    body["status_reason"] = "1 of 3 sources timed out"
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    with caplog.at_level("WARNING"):
        payload = ns.get_latest_panel_payload(["MSFT", "NVDA"])
    assert payload["signals"]                       # degraded != empty — still projected
    assert payload["status"] == "degraded"
    assert payload["status_reason"] == "1 of 3 sources timed out"
    assert any("degraded" in r.getMessage() for r in caplog.records)


def test_degraded_artifact_still_projects_in_backtest_path(monkeypatch):
    """`get_news_sentiment` (the per-step backtest loader) does not branch on
    status: a degraded-but-usable artifact still projects its signals rather
    than collapsing to empty."""
    body = dict(load_signals_wire_fixture())
    body["status"] = "degraded"
    body["status_reason"] = "partial feed"
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    ts = datetime(2026, 7, 10, 15, 0, tzinfo=timezone.utc)
    out = ns.get_news_sentiment(["MSFT", "NVDA"], ts)
    assert out["news_sentiment"]                    # non-empty: degraded is still projected
    assert out["news_overview"] == body["news_overview"]


def _body_without(field, *, symbols):
    """The wire fixture with `field` stripped from `symbols` — i.e. the shape a
    producer rename actually leaves behind."""
    body = dict(load_signals_wire_fixture())
    body["signals"] = {
        sym: {k: v for k, v in sig.items() if not (sym in symbols and k == field)}
        for sym, sig in body["signals"].items()
    }
    return body


def test_one_malformed_step_signal_does_not_blank_the_other_tickers(monkeypatch, caplog):
    """Per-entry isolation on the backtest path: one off-spec ticker must not
    take the readable ones down with it.

    Delete this and nothing stops the projection going back to a dict
    comprehension, where a single producer typo on MSFT empties the sentiment
    slot for EVERY ticker that step. _project_step_signals carries the why."""
    body = _body_without("sentiment_score", symbols={"MSFT"})
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    ts = datetime(2026, 7, 10, 15, 0, tzinfo=timezone.utc)

    with caplog.at_level("WARNING"):
        out = ns.get_news_sentiment(["MSFT", "NVDA"], ts)

    assert "MSFT" not in out["news_sentiment"]   # dropped...
    assert "NVDA" in out["news_sentiment"]       # ...without taking this one with it
    # Names the missing key, not a bare "malformed": "missing 'sentiment_score'"
    # on every ticker at once is what reads as a rename rather than as noise.
    assert any("sentiment_score" in r.getMessage() for r in caplog.records)


def test_every_step_signal_dropped_alarms_instead_of_reading_as_a_quiet_news_day(
        monkeypatch, caplog):
    """The case per-entry isolation would otherwise hide. A rename makes every
    entry unreadable, so log-and-drop alone yields an empty slot plus a few
    warnings — indistinguishable from "no news this step", which is exactly how
    the 2026-07-14 outage ran for hours on warnings nobody read."""
    body = _body_without("sentiment_score", symbols={"MSFT", "NVDA"})
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    ts = datetime(2026, 7, 10, 15, 0, tzinfo=timezone.utc)

    with caplog.at_level("ERROR"):
        out = ns.get_news_sentiment(["MSFT", "NVDA"], ts)

    assert out["news_sentiment"] == {}
    assert any("drift" in r.getMessage()
               for r in caplog.records if r.levelname == "ERROR")


def test_universe_filter_alone_is_not_drift(monkeypatch, caplog):
    """The alarm's `raw` is the post-filter set, never the wire's signals block.
    A signal for a ticker outside the universe is filtered by design, not dropped
    by drift — alarming on it would fire on every narrow-universe run and train
    the reader to ignore the one alarm that matters."""
    monkeypatch.setattr(ns, "_http_get",
                        lambda **kw: _fake_response(body=load_signals_wire_fixture()))
    ts = datetime(2026, 7, 10, 15, 0, tzinfo=timezone.utc)

    with caplog.at_level("ERROR"):
        out = ns.get_news_sentiment(["JPM"], ts)     # fixture has MSFT/NVDA only

    assert out["news_sentiment"] == {}               # correctly empty...
    assert not [r for r in caplog.records
                if r.levelname == "ERROR"]           # ...but not a contract break


def test_304_revalidation_serves_cached_body(monkeypatch):
    """A conditional GET that returns 304 serves the previously cached body
    (the latest-read path always sends If-None-Match). The on-disk fixture
    tests never reach this branch."""
    body = load_signals_wire_fixture()
    responses = [
        _fake_response(body=body, etag='"w1"'),
        _fake_response(status=304, body={}, etag='"w1"'),
    ]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: responses.pop(0))
    first = ns.get_latest_panel_payload(["MSFT"])
    assert first["staleness_hours"] == body["staleness_hours"]
    second = ns.get_latest_panel_payload(["MSFT"])   # 304 -> cached body reused, not refetched
    assert second["staleness_hours"] == body["staleness_hours"]
    assert not responses                             # both queued responses consumed


# --- Phase B: panel feed prefers the raw items endpoint --------------------
# The FinSearch producer now exposes GET /api/news/items/ (raw multi-story
# batch). The panel feed prefers it and falls back to the Phase-A
# representative feed (derived from `signals`) on ANY items failure, so the
# panel can never regress below Phase A. `signals`/status/overview/staleness
# always come from `fetch_signals` regardless of which feed source wins.


def _items_body(items, batch="items-test.jsonl"):
    return {"schema_version": 2, "items": items, "count": len(items), "batch": batch}


def test_items_feed_preferred_and_mapped_correctly(monkeypatch):
    """Happy path driven by the RECORDED producer response (items-wire-fixture)
    rather than dicts written inline here — so the wire shape the adapter is
    tested against is the one artifact a producer rename must visibly update."""
    signals_body = load_signals_fixture()
    items_body = load_items_wire_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body=items_body))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["news_overview"] == signals_body["news_overview"]  # signals side unchanged
    assert payload["signals"]
    feed = payload["feed"]
    # Phase B breadth: the whole batch is served, not just the signalled stories.
    assert len(feed) == len(items_body["items"]) > len(signals_body["signals"])
    assert feed[0] == {
        "headline": "Nvidia reports record datacenter orders", "source": "CNBC",
        "url": "https://example.com/nvda-1", "published": 1783339200.0, "ticker": "NVDA",
    }
    assert [e["published"] for e in feed] == sorted(
        (e["published"] for e in feed), reverse=True)  # newest-first
    assert feed[-1]["ticker"] is None  # general-market story: empty tickers -> None


def test_items_404_falls_back_to_representative_feed(monkeypatch):
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items",
                         lambda **kw: _fake_response(status=404, body={"error": "no_items"}))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])


def test_items_transport_error_falls_back_to_representative_feed(monkeypatch):
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    def _boom(**kw):
        raise OSError("connection refused")
    monkeypatch.setattr(ns, "_http_get_items", _boom)
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])


def test_items_missing_items_list_falls_back(monkeypatch):
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body={"count": 0}))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])


def test_items_non_dict_body_falls_back(monkeypatch):
    """A valid-JSON but non-dict items body (e.g. a bare list) must fail closed
    to None — body.get() on a list would AttributeError — so the panel falls
    back to the representative feed rather than raising."""
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items",
                         lambda **kw: _fake_response(body=[{"guid": "g1"}]))  # bare list, not a dict
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])


def test_items_unparseable_body_falls_back(monkeypatch):
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    def _raise_value_error():
        raise ValueError("bad json")
    monkeypatch.setattr(ns, "_http_get_items",
                         lambda **kw: SimpleNamespace(status_code=200, headers={}, json=_raise_value_error))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])


def test_items_all_malformed_falls_back(monkeypatch):
    signals_body = load_signals_fixture()
    malformed_items = [{"guid": "g1", "url": "https://x/1", "source": "Reuters",
                         "published": 1700000200.0, "tickers": ["AAPL"]}]  # missing "headline"
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body=_items_body(malformed_items)))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])


def test_items_all_dropped_logs_drift_error(monkeypatch, caplog):
    """Wholesale wire-shape drift must be LOUD. Every item failing to project is
    categorically different from one off-spec story: it means the producer's
    contract moved (as it did on 2026-07-14, when AF renamed title/link ->
    headline/url and this adapter silently served the Phase-A feed for hours on
    nothing but per-item warnings). The fallback keeps the panel alive; this
    ERROR is the only thing that says the items feed is dead."""
    signals_body = load_signals_fixture()
    drifted_items = [{"guid": "g1", "title": "Fed cuts rates", "link": "https://x/1",
                      "source": "Reuters", "published": 1700000200.0, "tickers": ["AAPL"]}]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body=_items_body(drifted_items)))
    with caplog.at_level("ERROR"):
        payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])  # still fails closed
    drift = [r for r in caplog.records if r.levelname == "ERROR" and "0 usable entries" in r.getMessage()]
    assert len(drift) == 1
    assert "1 raw item" in drift[0].getMessage()  # reports the raw count that was dropped


def test_partial_malformed_items_does_not_log_drift_error(monkeypatch, caplog):
    """The counterpart to the drift alarm: one bad story among good ones is
    routine producer noise, already covered by the per-item warning. Escalating
    that to ERROR would train everyone to ignore the alarm that matters."""
    signals_body = load_signals_fixture()
    items = [
        {"guid": "g1", "headline": "Fed cuts rates", "url": "https://x/1", "source": "Reuters",
         "published": 1700000200.0, "tickers": ["AAPL"]},
        {"guid": "g2", "source": "Bloomberg", "published": 1700000100.0, "tickers": []},  # malformed
    ]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body=_items_body(items)))
    with caplog.at_level("WARNING"):
        payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert [e["headline"] for e in payload["feed"]] == ["Fed cuts rates"]  # good item survives
    assert not [r for r in caplog.records if r.levelname == "ERROR"]


def test_items_empty_list_does_not_log_drift_error(monkeypatch, caplog):
    """An empty batch is "no news yet", not drift — there is nothing to have
    dropped. Only a non-empty batch that projects to nothing is a contract break."""
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items", lambda **kw: _fake_response(body=_items_body([])))
    with caplog.at_level("ERROR"):
        payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])
    assert not [r for r in caplog.records if r.levelname == "ERROR"]


def test_representative_fallback_all_dropped_logs_drift_error(monkeypatch, caplog):
    """The fallback earns the same alarm as the path it backstops — arguably more:
    a signals-side rename leaves nothing to fall back TO, so the feed goes blank
    rather than merely stale. Alarming only the items path would mean the *worse*
    outage is the quieter one. (Items 404s here via the autouse default, so this
    is the last-resort path.)"""
    signals_body = load_signals_fixture()
    drifted = {sym: {k: v for k, v in sig.items() if k != "headline"}
               for sym, sig in signals_body["signals"].items()}
    monkeypatch.setattr(ns, "_http_get",
                        lambda **kw: _fake_response(body={**signals_body, "signals": drifted}))
    with caplog.at_level("ERROR"):
        payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["feed"] == []          # nothing left to serve
    assert payload["signals"] == drifted  # signals still pass through untouched
    drift = [r for r in caplog.records
             if r.levelname == "ERROR" and "0 usable entries" in r.getMessage()]
    assert len(drift) == 1


def test_every_concurrent_drift_gets_its_own_alarm(monkeypatch, caplog):
    """Two projections drifting at once must produce two ERRORs, not one.

    Each alarm is OR-ed into `drifted` as `_alarm(...) or drifted` — alarm
    first. Written the other way round (`drifted or _alarm(...)`) it reads
    identically and is a silent regression: `or` short-circuits, so the first
    drift would suppress every later alarm's log, and the operator would learn
    the feed broke but never that the directional reads went with it. Nothing
    else in the suite fails on that flip, so it is pinned here."""
    signals_body = load_signals_fixture()
    # headline gone -> the Phase-A feed drifts; sentiment_score gone -> the panel
    # signals drift. Independent projections, so both alarms are due.
    drifted = {sym: {k: v for k, v in sig.items()
                     if k not in ("headline", "sentiment_score")}
               for sym, sig in signals_body["signals"].items()}
    monkeypatch.setattr(ns, "_http_get",
                        lambda **kw: _fake_response(body={**signals_body, "signals": drifted}))
    with caplog.at_level("ERROR"):
        payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["signals"] == {} and payload["feed"] == []
    sources = {r.getMessage().split(":")[1].split(" produced")[0].strip()
               for r in caplog.records
               if r.levelname == "ERROR" and "0 usable entries" in r.getMessage()}
    assert sources == {"panel signals list", "Phase-A signals feed"}


def test_empty_signals_artifact_does_not_log_drift_error(monkeypatch, caplog):
    """A quiet news day — an artifact carrying zero signals — legitimately
    projects to an empty feed. Nothing was dropped, so nothing drifted. This is
    the signals-side twin of the empty-batch case: it pins the "non-empty raw"
    half of the alarm's predicate, which is the half that keeps it from firing
    on the most ordinary state there is."""
    signals_body = load_signals_fixture()
    monkeypatch.setattr(ns, "_http_get",
                        lambda **kw: _fake_response(body={**signals_body, "signals": {}}))
    with caplog.at_level("ERROR"):
        payload = ns.get_latest_panel_payload([])
    assert payload["feed"] == []
    assert payload["signals"] == {}
    assert not [r for r in caplog.records if r.levelname == "ERROR"]


# --- Drift is visible in the UI, not just in the logs -------------------------
# A log line only reaches whoever is reading logs. The 2026-07-14 rename proved
# nobody was: the panel looked fine, so the break sat there for hours. These pin
# drift to the `degraded` badge the panel already renders.

def test_items_drift_surfaces_as_degraded_in_the_panel_badge(monkeypatch):
    """The panel keeps working off the Phase-A fallback — which is exactly why it
    has to say so. A silently-narrower feed is indistinguishable from a quiet
    news day to the person looking at it."""
    signals_body = load_signals_fixture()
    drifted_items = [{"guid": "g1", "title": "Fed cuts rates", "link": "https://x/1",
                      "source": "Reuters", "published": 1700000200.0, "tickers": ["AAPL"]}]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=signals_body))
    monkeypatch.setattr(ns, "_http_get_items",
                        lambda **kw: _fake_response(body=_items_body(drifted_items)))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["status"] == "degraded"
    assert ns._DRIFT_STATUS_REASON in payload["status_reason"]
    assert payload["feed"] == ns._representative_feed(signals_body["signals"])  # still serving


def test_signals_drift_surfaces_as_degraded(monkeypatch):
    """The fallback drifting is the worse case — the feed is empty, not merely
    narrower — so it must reach the badge too."""
    signals_body = load_signals_fixture()
    drifted = {sym: {k: v for k, v in sig.items() if k != "headline"}
               for sym, sig in signals_body["signals"].items()}
    monkeypatch.setattr(ns, "_http_get",
                        lambda **kw: _fake_response(body={**signals_body, "signals": drifted}))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["status"] == "degraded"
    assert ns._DRIFT_STATUS_REASON in payload["status_reason"]
    assert payload["feed"] == []


def test_healthy_panel_is_not_marked_degraded(monkeypatch):
    """The badge must stay dark on the happy path. A warning light that is always
    on is a warning light nobody reads — this is the assertion that keeps the
    new escalation from devaluing the badge it hangs on."""
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=load_signals_fixture()))
    monkeypatch.setattr(ns, "_http_get_items",
                        lambda **kw: _fake_response(body=load_items_wire_fixture()))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["status"] == "ok"
    assert payload["status_reason"] is None


def test_drift_does_not_swallow_the_producers_own_degraded_reason(monkeypatch):
    """Two independent things can be wrong at once: a source can time out (the
    producer's own `degraded`) while the wire shape ALSO moved. Ours must not
    overwrite theirs — the badge should report both, not the last one to run."""
    signals_body = load_signals_fixture()
    body = {**signals_body, "status": "degraded",
            "status_reason": "1 of 3 sources timed out"}
    drifted_items = [{"guid": "g1", "title": "t", "link": "https://x/1",
                      "source": "Reuters", "published": 1700000200.0, "tickers": []}]
    monkeypatch.setattr(ns, "_http_get", lambda **kw: _fake_response(body=body))
    monkeypatch.setattr(ns, "_http_get_items",
                        lambda **kw: _fake_response(body=_items_body(drifted_items)))
    payload = ns.get_latest_panel_payload(["MSFT", "AAPL"])
    assert payload["status"] == "degraded"
    assert "1 of 3 sources timed out" in payload["status_reason"]  # theirs survives
    assert ns._DRIFT_STATUS_REASON in payload["status_reason"]     # ours is added


def test_signals_down_returns_unavailable_and_skips_items_fetch(monkeypatch):
    def _boom(**kw):
        raise OSError("down")
    monkeypatch.setattr(ns, "_http_get", _boom)
    def _fetch_items_must_not_be_called(**kw):
        raise AssertionError("fetch_items must not be called when signals is down")
    monkeypatch.setattr(ns, "fetch_items", _fetch_items_must_not_be_called)
    payload = ns.get_latest_panel_payload(["MSFT"])
    assert payload == ns.UNAVAILABLE_PAYLOAD


def test_feed_from_items_maps_exact_five_keys():
    items = [
        {"guid": "g1", "headline": "Fed cuts rates", "url": "https://x/1", "source": "Reuters",
         "published": 1700000200.0, "description": "d1", "tickers": ["AAPL", "MSFT"],
         "editorial_score": 0.5},
    ]
    feed = ns._feed_from_items(items)
    assert feed == [{
        "headline": "Fed cuts rates", "source": "Reuters", "url": "https://x/1",
        "published": 1700000200.0, "ticker": "AAPL",
    }]
    assert set(feed[0].keys()) == {"headline", "source", "url", "published", "ticker"}

"""FinSearch news-sentiment adapter (Plan 1).

Consumers:
- execution/backtest_backend.py::load_news_sentiment  (fail-closed, per-step as_of)
- api/routers/news.py                                  (latest artifact, panel payload)

Contract: docs/integrations/finsearch-news-sentiment.md
"""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Set, Tuple, Union

import requests

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://agenticfinsearch.org/api/signals/news/"
DEFAULT_ITEMS_URL = "https://agenticfinsearch.org/api/news/items/"
_PANEL_FEED_LIMIT = 50   # how many raw items to request for the panel's left column
_TIMEOUT_SECONDS = 10
_MAX_CACHE_ENTRIES = 64  # bounded — a long-lived server must not grow monotonically
# Short throttle window for today/latest *failures* (outage/config errors), so a
# producer outage can't re-hit the bearer-gated endpoint on every step or poll.
# Mirrors cache.TTL_NEWS_UNAVAILABLE; kept local so the adapter stays usable
# independently of the router's cache module.
_NEGATIVE_TTL_SECONDS = 30

UNAVAILABLE_PAYLOAD = {
    "status": "unavailable", "status_reason": None, "generated_at": None,
    "staleness_hours": None, "news_overview": None, "signals": {}, "feed": [],
}
# Rendered to the reader by the panel badge as `degraded: <this>`, so it names
# what they lost rather than the mechanism that lost it ("wire-shape drift" is
# for the log line and the on-call reader, not the person reading the news).
_DRIFT_STATUS_REASON = "news feed incomplete — upstream story format changed"

_lock = threading.Lock()
# key: (as_of or "", tickers_key) -> {"etag": str|None, "body": dict|None,
#                                     "expires_at": float|None}
# expires_at is a time.monotonic() deadline set ONLY on today/latest negative
# entries (the outage throttle). None means "no throttle": positive bodies,
# immutable past gaps, and today's 404-waiting-for-heartbeat gaps.
_CACHE: Dict[Tuple[str, str], Dict[str, Any]] = {}
# Keys with a leader currently hitting the producer (single-flight). Concurrent
# callers read the freshest cached body instead of stampeding the producer or
# blocking a threadpool worker behind the leader's ~10s call.
_inflight: Set[Tuple[str, str]] = set()
_MISS = object()  # sentinel: a cached None body (a served gap) is a real hit


def clear_cache() -> None:
    with _lock:
        _CACHE.clear()
        _inflight.clear()


def _base_url() -> str:
    return os.environ.get("FINSEARCH_SIGNALS_URL", DEFAULT_BASE_URL)


def _items_url() -> str:
    return os.environ.get("FINSEARCH_ITEMS_URL", DEFAULT_ITEMS_URL)


def _headers() -> Dict[str, str]:
    key = os.environ.get("FINGPT_API_KEY", "")
    return {"Authorization": f"Bearer {key}"} if key else {}


def _http_get(*, params: Dict[str, str], headers: Dict[str, str]):
    return requests.get(_base_url(), params=params, headers=headers,
                        timeout=_TIMEOUT_SECONDS)


def _http_get_items(*, params: Dict[str, str], headers: Dict[str, str]):
    return requests.get(_items_url(), params=params, headers=headers,
                        timeout=_TIMEOUT_SECONDS)


def _coerce_timestamp(timestamp: Union[str, datetime, None]) -> Optional[datetime]:
    """The v2 step envelope serializes timestamps to ISO strings
    (external_run_service.py:429-431), so the REAL backtest call site passes
    str; direct callers may pass datetime. Returns tz-aware datetime or None."""
    if timestamp is None:
        return None
    if isinstance(timestamp, str):
        try:
            # Mirror equity_plot.parse_equity_timestamp: bare fromisoformat can't
            # parse a trailing "Z", so normalize it to an explicit UTC offset.
            timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            logger.error("news_sentiment: unparseable timestamp %r", timestamp)
            return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp


def _write(key, *, etag, body, expires_at) -> None:
    """Store a cache entry (caller holds _lock). Bounded, oldest-inserted evicted."""
    _CACHE[key] = {"etag": etag, "body": body, "expires_at": expires_at}
    while len(_CACHE) > _MAX_CACHE_ENTRIES:
        _CACHE.pop(next(iter(_CACHE)))  # evict oldest-inserted


def _serve_from_memo(cached, is_past):
    """Whether a cached entry can be served without an HTTP call (caller holds
    _lock). Returns _MISS when a (re)fetch is required."""
    if cached is None:
        return _MISS
    if is_past:
        return cached["body"]  # immutable past: positive body OR honest gap
    # today/latest: positive bodies always revalidate (ETag), 404 gaps keep
    # re-checking for the heartbeat; only a *throttled* negative entry serves.
    exp = cached.get("expires_at")
    if cached["body"] is None and exp is not None and time.monotonic() < exp:
        return None
    return _MISS


def _store_response(key, is_past, *, etag, body, is_404) -> None:
    """Cache an HTTP result (caller holds _lock), applying the negative-cache
    policy: throttle only today/latest OUTAGE gaps; never throttle a 404
    (waiting for the heartbeat) or an immutable past gap."""
    if body is not None or is_past or is_404:
        expires_at = None
    else:
        expires_at = time.monotonic() + _NEGATIVE_TTL_SECONDS
    _write(key, etag=etag, body=body, expires_at=expires_at)


def _parse_response(resp, as_of) -> Optional[dict]:
    """Extract the usable body from a producer response (None on any non-200 or
    unusable body), logging each failure class."""
    if resp.status_code == 200:
        try:
            body = resp.json()
        except ValueError:
            logger.error("news_sentiment: unparseable producer body")
            return None
        if body.get("status") == "degraded":
            logger.warning("news_sentiment: degraded artifact: %s",
                           body.get("status_reason"))
        return body
    if resp.status_code == 401:
        logger.error("news_sentiment: 401 from producer — missing/wrong FINGPT_API_KEY")
    elif resp.status_code == 503:
        logger.error("news_sentiment: 503 — producer auth misconfigured server-side")
    elif resp.status_code == 400:
        logger.error("news_sentiment: 400 bad_as_of — adapter bug (as_of=%r)", as_of)
    elif resp.status_code == 404:
        pass  # no artifact at/before as_of: normal for early steps
    else:
        logger.warning("news_sentiment: unexpected status %s", resp.status_code)
    return None


def fetch_signals(*, as_of: Optional[str], tickers: Tuple[str, ...]) -> Optional[dict]:
    """Fetch one signals artifact; None on any failure (fail closed, log loud).

    Memo policy: keys dated STRICTLY BEFORE today (UTC) are served from the
    memo without HTTP once any result — including a config-error None — is
    cached (past days are immutable, and a 401/timeout must not turn a 161-step
    backtest into 161 live calls). Keys for today, and the `as_of=None` "latest"
    read, always revalidate (ETag/If-None-Match), EXCEPT an outage/config
    failure is negative-cached for _NEGATIVE_TTL_SECONDS so a sustained outage
    is throttled there too; a 404 is never throttled (it must pick up the daily
    heartbeat promptly). A transport failure NEVER serves a previously cached
    body — stale data presented as fresh is worse than an honest gap.

    Single-flight: exactly one leader per key hits the producer; concurrent
    callers return the freshest cached body without blocking, so a burst can't
    stampede the producer or pile up threadpool workers behind one ~10s call.
    """
    key = (as_of or "", ",".join(tickers))
    today = datetime.now(timezone.utc).date().isoformat()
    is_past = bool(as_of) and as_of < today  # ISO dates sort lexically

    with _lock:
        cached = _CACHE.get(key)
        served = _serve_from_memo(cached, is_past)
        if served is not _MISS:
            return served
        if key in _inflight:
            # Follower: a leader is already fetching this key. Do not hit the
            # producer and do not block on it — return the freshest body we have.
            return cached["body"] if cached else None
        _inflight.add(key)

    try:
        params: Dict[str, str] = {}
        if as_of:
            params["as_of"] = as_of
        if tickers:
            params["tickers"] = ",".join(tickers)
        headers = _headers()
        if cached and cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        try:
            resp = _http_get(params=params, headers=headers)
        except Exception as exc:  # network/timeout: fail closed, never stale
            logger.warning("news_sentiment: fetch failed: %s", exc)
            with _lock:
                # Memoize the gap so an outage can't re-hit every step: permanent
                # for immutable past dates; a short throttle for today/latest, but
                # never clobber an existing good body (keep it to revalidate later).
                if is_past:
                    _write(key, etag=None, body=None, expires_at=None)
                elif cached is None or cached["body"] is None:
                    _write(key, etag=None, body=None,
                           expires_at=time.monotonic() + _NEGATIVE_TTL_SECONDS)
            return None
        if resp.status_code == 304 and cached:
            return cached["body"]
        body = _parse_response(resp, as_of)
        with _lock:
            _store_response(key, is_past, etag=resp.headers.get("ETag"),
                            body=body, is_404=(resp.status_code == 404))
        return body
    finally:
        with _lock:
            _inflight.discard(key)


def _story_fields(sig: dict) -> dict:
    """Shared story projection (headline/source/url) used by BOTH the per-step
    backtest entry and the panel feed, so the field list lives in one place."""
    return {"headline": sig["headline"], "source": sig["source"], "url": sig["url"]}


def _project_entry(sig: dict, reference_ts: float) -> dict:
    return {
        "sentiment": sig["sentiment"],
        # Asymmetry is deliberate, not a half-finished rename: the wire's key is
        # `sentiment_score`, the internal envelope's is `score` (validated by
        # api/v2/models.py's NewsSentimentEntry). Do NOT "fix" the emitted key
        # to match the wire. No v1 fallback — a KeyError here means the producer
        # contract broke and must be seen, not smoothed over.
        "score": sig["sentiment_score"],
        **_story_fields(sig),
        "n_articles": sig["n_articles"],
        "age_hours": max(0.0, (reference_ts - float(sig["published"])) / 3600.0),
        "rationale": sig.get("rationale"),
    }


def _project_step_signals(considered: dict, reference_ts: float) -> dict:
    """Per-step backtest signals projected to the internal entry shape, dropping
    the entries `_project_entry` cannot read.

    The isolation is the whole point. This was a dict comprehension, so one
    off-spec ticker raised out of the entire projection and the caller blanked
    the sentiment slot for EVERY ticker that step — a producer typo on MSFT
    silently deleting NVDA's news. The panel has always dropped and carried on
    (_representative_feed); the backtest is the projection that never learned it.

    A dropped ticker is indistinguishable from a ticker with no news — which is
    the shape this dict already has (only tickers WITH signals appear), so the
    blast radius shrinks from "every ticker" to "the broken one". Wholesale
    drift is the case that still needs saying out loud: see the caller's
    _alarm_if_all_dropped.

    `_project_entry` stays the single source of which fields are required, and a
    KeyError names the missing one — so an all-tickers-at-once "missing
    'sentiment_score'" reads as a rename rather than as routine noise.
    """
    projected = {}
    for sym, sig in considered.items():
        try:
            projected[sym] = _project_entry(sig, reference_ts)
        except (KeyError, TypeError, ValueError) as exc:
            logger.warning("news_sentiment: dropping step signal %r — %s: %s",
                           sym, type(exc).__name__, exc)
    return projected


def get_news_sentiment(universe, timestamp) -> dict:
    """Contract interface for execution/backtest_backend.load_news_sentiment.

    Reports its own contract breaks (drop + warn per entry, ERROR on wholesale
    drift) rather than raising them at the caller. The caller's fail-closed
    try/except is a backstop for the genuinely unexpected, not the thing that
    makes a producer rename visible — leaving that to the caller made the
    reporting only as good as each new caller's memory to re-implement it.
    """
    empty = {"news_sentiment": {}, "news_overview": None}
    ts = _coerce_timestamp(timestamp)
    if ts is None:
        return empty
    as_of = ts.date().isoformat()
    reference_ts = ts.timestamp()
    tickers = tuple(sorted(universe or ()))
    body = fetch_signals(as_of=as_of, tickers=tickers)
    if not body:
        return empty
    wanted = set(tickers)
    considered = {sym: sig for sym, sig in (body.get("signals") or {}).items()
                  if not wanted or sym in wanted}
    out = _project_step_signals(considered, reference_ts)
    # `considered`, never the raw signals block: a signal for a ticker outside
    # the universe is filtered by design, not dropped by drift, so alarming on
    # it would cry wolf on every narrow-universe run and train the reader to
    # ignore the one alarm that matters.
    _alarm_if_all_dropped(considered, out, source="backtest step signals",
                          consequence="this step's sentiment slot is empty")
    return {"news_sentiment": out, "news_overview": body.get("news_overview")}


def _feed_sort_key(item: dict) -> float:
    """Sort by published epoch; a malformed/missing timestamp sinks to the
    bottom instead of throwing and collapsing the whole feed."""
    try:
        return float(item["published"])
    except (TypeError, ValueError):
        return 0.0


def fetch_items(*, limit: int = _PANEL_FEED_LIMIT) -> Optional[list]:
    """Newest raw news-items batch for the panel feed. Returns list[dict], or
    None on ANY failure (fail closed — the caller falls back to the
    signals-derived representative feed). Latest-only, no as_of; the
    /api/news/signals router already caches the panel payload, so no extra
    memo here."""
    try:
        resp = _http_get_items(params={"limit": str(limit)}, headers=_headers())
    except Exception as exc:  # network/timeout: fail closed
        logger.warning("news_sentiment: items fetch failed: %s", exc)
        return None
    if resp.status_code == 200:
        try:
            body = resp.json()
        except ValueError:
            logger.error("news_sentiment: unparseable items body")
            return None
        items = body.get("items") if isinstance(body, dict) else None
        if not isinstance(items, list):
            logger.error("news_sentiment: items body missing 'items' list")
            return None
        return items
    if resp.status_code == 401:
        logger.error("news_sentiment: 401 from producer — missing/wrong FINGPT_API_KEY (items)")
    elif resp.status_code == 404:
        pass  # no items batch yet: normal
    else:
        logger.warning("news_sentiment: unexpected items status %s", resp.status_code)
    return None


def _feed_from_items(items) -> list:
    """Project news-story v2 items onto the panel feed keys — a near-
    passthrough now that AF's items endpoint speaks the shared vocabulary
    (headline/url on the wire; docs/integrations/finsearch-news-items.md):
    headline->headline, url->url, source->source, published->published,
    tickers[0]|None->ticker. Drops a malformed item (KeyError/TypeError)
    with a warning instead of collapsing the feed. Sorted newest-first via
    _feed_sort_key.

    The story triple comes from _story_fields — the same helper the signals
    paths use. That sharing is only possible now that AF speaks one vocabulary
    on both endpoints, and it is the point: the field list a rename would move
    exists once."""
    feed = []
    for item in items:
        try:
            tickers = item["tickers"]
            entry = {
                **_story_fields(item),
                "published": item["published"],
                "ticker": tickers[0] if tickers else None,
            }
        except (KeyError, TypeError):
            logger.warning("news_sentiment: dropping malformed panel item %r",
                           item.get("guid") if isinstance(item, dict) else item)
            continue
        feed.append(entry)
    feed.sort(key=_feed_sort_key, reverse=True)
    return feed


def _alarm_if_all_dropped(raw, projected: Union[list, dict], *, source: str,
                          consequence: str) -> bool:
    """Whether `raw` projected to NOTHING — i.e. the wire contract moved rather
    than one story being off-spec — logging an ERROR if so. An empty batch is
    "no news", not drift.

    Failing closed is not the same as failing visibly, and every projection here
    only buys the first: a malformed entry is dropped with a per-entry warning
    and the caller carries on, so a producer renaming a field looks exactly like
    routine noise. On 2026-07-14 AF renamed title/link -> headline/url and this
    adapter served the Phase-A feed for hours on warnings alone.

    What a True is worth is the caller's to decide, and the callers differ. The
    panel's escalate it to `degraded` so the break reaches the badge — a log line
    only ever reaches whoever happens to be reading logs, and nobody was. The
    backtest path has no equivalent channel and is log-only pending #123. So do
    not read this helper as a promise that drift always reaches a human; it
    reports, and reporting is only as loud as the channel the caller gives it."""
    if not (raw and not projected):
        return False
    logger.error("news_sentiment: %s produced 0 usable entries from %d raw "
                 "item(s) — producer wire-shape drift? %s",
                 source, len(raw), consequence)
    return True


def _representative_feed(signals: dict) -> list:
    """Phase-A feed: one representative story per signal. Used as the panel
    feed's fallback when the raw-items feed is unavailable."""
    feed = []
    for sym, s in signals.items():
        try:
            story = _story_fields(s)  # requires headline/source/url
        except (KeyError, TypeError):
            logger.warning("news_sentiment: dropping malformed panel signal %r", sym)
            continue
        feed.append({**story, "published": s.get("published"), "ticker": sym})
    feed.sort(key=_feed_sort_key, reverse=True)
    return feed


# The keys home-news-signals.js reads off each `signals` entry to render a row.
# `rationale` is deliberately absent — the panel null-coalesces it (`|| ''`) —
# and so are headline/published/guid/n_articles, which only the feed projection
# needs. Coupling the two projections' requirements would drop a usable story
# from the feed because its sentiment read was broken, or vice versa.
_PANEL_SIGNAL_KEYS = ("sentiment", "sentiment_score", "url", "source")


def _project_panel_signals(signals: dict) -> dict:
    """Panel `signals` projected to the entries the UI can actually render.

    Projecting is what makes the path watchable at all: `_alarm_if_all_dropped`
    only ever sees what a projection dropped, so while this dict reached the
    browser raw from the wire no alarm could cover it. Nothing reads
    `sentiment_score` server-side — the browser does, where
    `Number(undefined).toFixed(2)` renders the *string* "NaN", so a rename would
    paint "NVDA NaN" into every chip with no drop, no exception and no log.

    Naming the missing key in the log is the point: "missing sentiment_score"
    on every ticker at once reads as a rename, where a bare "malformed signal"
    reads as routine noise.
    """
    projected = {}
    for sym, s in signals.items():
        if not isinstance(s, dict):
            logger.warning("news_sentiment: dropping panel signal %r — not an object", sym)
            continue
        missing = [k for k in _PANEL_SIGNAL_KEYS if k not in s]
        if missing:
            logger.warning("news_sentiment: dropping panel signal %r — missing %s",
                           sym, ", ".join(missing))
            continue
        projected[sym] = s
    return projected


def get_latest_panel_payload(tickers) -> dict:
    """Latest-artifact read for the Home panel (no as_of).

    `feed` prefers the richer raw-items endpoint (Phase B: multiple stories
    per signal) and falls back to the Phase-A representative feed (one story
    per signal, derived from `signals`) on ANY items failure — so the panel
    can never regress below Phase A. `signals`/status/overview/staleness
    always come from `fetch_signals`: it is the gate, so when it fails the
    panel is unavailable regardless of items, and `fetch_items` is not even
    called.

    One malformed signal/item is dropped (logged) rather than collapsing the
    whole panel: the producer is the trust boundary, but a single off-spec
    entry must still degrade to partial rendering, not an outage. Wholesale
    drift is the other story — see _alarm_if_all_dropped, applied to ALL THREE
    projections: the fallback needs the alarm at least as much as the path it
    backstops, because when IT drifts there is nothing left to fall back to,
    and `signals` needs one because it is what the panel is actually for.

    `signals` and `feed` are each projected from the raw wire dict, never from
    each other — see _PANEL_SIGNAL_KEYS for why their required keys have to stay
    independent.

    Drift also escalates the payload to `degraded`, which the panel renders as a
    badge. The fallback is what makes this necessary rather than redundant: it
    keeps the panel looking healthy, so without the badge the only symptom is a
    quieter feed that nobody can distinguish from a slow news day."""
    body = fetch_signals(as_of=None, tickers=tuple(sorted(tickers or ())))
    if not body:
        return dict(UNAVAILABLE_PAYLOAD)
    signals = body.get("signals") or {}
    panel_signals = _project_panel_signals(signals)
    # Call the alarm BEFORE the `or`, never after it: `drifted or _alarm(...)`
    # short-circuits once anything has drifted, swallowing the ERROR the alarm
    # exists to emit. Every alarm ORs, so their order carries no other meaning.
    drifted = _alarm_if_all_dropped(
        signals, panel_signals, source="panel signals list",
        consequence="the panel's directional reads are now empty")
    feed = None
    items = fetch_items()
    if items:
        feed = _feed_from_items(items)
        drifted = _alarm_if_all_dropped(items, feed, source="items feed",
                                        consequence="falling back to the Phase-A feed") or drifted
    if not feed:  # None, [], or all-malformed -> fall back to Phase A
        feed = _representative_feed(signals)
        drifted = _alarm_if_all_dropped(signals, feed, source="Phase-A signals feed",
                                        consequence="the panel feed is now empty") or drifted
    status = body.get("status", "ok")
    status_reason = body.get("status_reason")
    if drifted:
        # The producer's own reason (a source timed out) and ours (the wire shape
        # moved) are independent failures; keep both rather than let whichever
        # ran last win the badge.
        status = "degraded"
        status_reason = "; ".join(filter(None, (status_reason, _DRIFT_STATUS_REASON)))
    return {
        "status": status,
        "status_reason": status_reason,
        "generated_at": body.get("generated_at"),
        "staleness_hours": body.get("staleness_hours"),
        "news_overview": body.get("news_overview"),
        "signals": panel_signals,
        "feed": feed,
    }

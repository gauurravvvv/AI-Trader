"""Single-flight read-through primitive (PaperTradingCache.get_or_fetch).

Centralizes the outage-throttle + stampede protection the news router used to
hand-roll as a global lock held across a ~10s upstream call. The follower test
is the one that matters: a concurrent cold-cache caller must return WITHOUT
running the fetch and WITHOUT blocking a threadpool worker behind the leader."""
import threading

from dashboard.backend.cache import PaperTradingCache


def test_leader_caches_and_followers_reuse():
    c = PaperTradingCache()
    calls = []

    def fetch():
        calls.append(1)
        return {"v": 1}

    a = c.get_or_fetch("k", fetch, ttl_seconds=60)
    b = c.get_or_fetch("k", fetch, ttl_seconds=60)
    assert a == b == {"v": 1}
    assert len(calls) == 1  # second served from cache, fetch not re-run


def test_negative_result_uses_short_ttl():
    c = PaperTradingCache()
    seen = {}
    real_set = c.set

    def spy_set(key, value, ttl_seconds=30):
        seen["ttl"] = ttl_seconds
        return real_set(key, value, ttl_seconds=ttl_seconds)

    c.set = spy_set
    c.get_or_fetch(
        "k", lambda: {"status": "unavailable"},
        ttl_seconds=420, negative_ttl_seconds=30,
        is_negative=lambda v: v.get("status") == "unavailable",
    )
    assert seen["ttl"] == 30  # negative branch, not the 420 positive TTL


def test_none_result_is_not_cached():
    c = PaperTradingCache()
    calls = []

    def fetch():
        calls.append(1)
        return None

    assert c.get_or_fetch("k", fetch, ttl_seconds=60, default={"d": 1}) == {"d": 1}
    c.get_or_fetch("k", fetch, ttl_seconds=60, default={"d": 1})
    assert len(calls) == 2  # None never cached -> re-fetched


def test_follower_returns_default_without_fetching_or_blocking():
    c = PaperTradingCache()
    started, release, calls = threading.Event(), threading.Event(), []

    def slow():
        calls.append(1)
        started.set()
        release.wait(2.0)
        return {"v": 1}

    out = {}
    leader = threading.Thread(
        target=lambda: out.__setitem__(
            "leader", c.get_or_fetch("k", slow, ttl_seconds=60, default={"d": 1})))
    leader.start()
    assert started.wait(2.0)                       # leader is mid-fetch, holds _inflight
    out["follower"] = c.get_or_fetch("k", slow, ttl_seconds=60, default={"d": 1})
    assert out["follower"] == {"d": 1}             # returned immediately, no block
    assert len(calls) == 1                         # follower did not run slow()
    release.set()
    leader.join(2.0)
    assert out["leader"] == {"v": 1}

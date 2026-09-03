"""Per-agent token-bucket rate limiting for /api/v2 (spec §6)."""

from __future__ import annotations

import math
import os
import threading
import time
from typing import Dict

from dashboard.backend.api.v2.errors import ApiError

RATE_PER_MINUTE = int(os.getenv("V2_RATE_LIMIT_PER_MINUTE", "120"))
MAX_BUCKETS = int(os.getenv("V2_RATE_LIMIT_MAX_BUCKETS", "10000"))


class TokenBucketLimiter:
    """A token bucket per agent_id. Refills at per_minute/60 tokens per second.

    The registry is bounded: agent registration is unauthenticated, so an
    unbounded dict keyed by agent_id would be a slow memory-DoS vector."""

    def __init__(self, per_minute: int = RATE_PER_MINUTE, burst: int | None = None,
                 max_buckets: int = MAX_BUCKETS):
        self.per_minute = max(1, per_minute)
        self.burst = max(1, burst if burst is not None else per_minute)
        self.refill_per_sec = self.per_minute / 60.0
        self.max_buckets = max(1, max_buckets)
        self._buckets: Dict[str, tuple[float, float]] = {}  # agent_id -> (tokens, last_ts)
        self._lock = threading.Lock()

    def _evict_locked(self, now: float) -> None:
        """Drop buckets that no longer carry state (caller holds the lock).

        A fully-refilled bucket is behaviorally identical to an absent one, so
        evicting it never changes a rate-limit decision. If everything is still
        hot (an actual flood), drop the least-recently-used tenth — those
        callers just get a fresh (full) bucket, which only errs permissive.
        """
        full = [
            key for key, (tokens, last) in self._buckets.items()
            if tokens + (now - last) * self.refill_per_sec >= self.burst
        ]
        for key in full:
            del self._buckets[key]
        if len(self._buckets) >= self.max_buckets:
            oldest = sorted(self._buckets, key=lambda k: self._buckets[k][1])
            for key in oldest[:max(1, self.max_buckets // 10)]:
                del self._buckets[key]

    def check(self, agent_id: str) -> Dict[str, object]:
        now = time.monotonic()
        with self._lock:
            if agent_id not in self._buckets and len(self._buckets) >= self.max_buckets:
                self._evict_locked(now)
            tokens, last = self._buckets.get(agent_id, (float(self.burst), now))
            tokens = min(self.burst, tokens + (now - last) * self.refill_per_sec)
            allowed = tokens >= 1.0
            if allowed:
                tokens -= 1.0
            self._buckets[agent_id] = (tokens, now)
        remaining = int(tokens)
        retry_after = 0 if allowed else int(math.ceil((1.0 - tokens) / self.refill_per_sec))
        return {
            "allowed": allowed,
            "limit": self.per_minute,
            "remaining": remaining,
            "reset": int(math.ceil((self.burst - tokens) / self.refill_per_sec)),
            "retry_after": retry_after,
        }


# Process-wide limiter shared by all v2 endpoints.
limiter = TokenBucketLimiter()


def enforce(agent_id: str, response) -> None:
    """Consume one token; set X-RateLimit-* headers; raise rate_limited on miss."""
    state = limiter.check(agent_id)
    rl_headers = {
        "X-RateLimit-Limit": str(state["limit"]),
        "X-RateLimit-Remaining": str(state["remaining"]),
        "X-RateLimit-Reset": str(state["reset"]),
    }
    response.headers.update(rl_headers)
    if not state["allowed"]:
        # Carry the headers on the error too: the envelope handler renders a
        # fresh JSONResponse, so the ones set above never reach the client.
        raise ApiError(
            "rate_limited", "Rate limit exceeded", status=429,
            details={"retry_after": state["retry_after"]}, retryable=True,
            headers=rl_headers,
        )

"""Panel proxy for FinSearch news signals — keeps FINGPT_API_KEY server-side."""
from fastapi import APIRouter

from dashboard.backend.cache import (CACHE_KEY_NEWS_SIGNALS, TTL_NEWS,
                                     TTL_NEWS_UNAVAILABLE, shared_ttl_cache)
from dashboard.backend.infrastructure.llm.validator import DJIA_30
from dashboard.backend.integrations import news_sentiment

router = APIRouter(prefix="/news", tags=["news"])


def _fetch_panel() -> dict:
    # get_latest_panel_payload already fails closed to UNAVAILABLE_PAYLOAD; the
    # except is a belt-and-braces guard so a bug can't leak a 500 to the panel.
    try:
        return news_sentiment.get_latest_panel_payload(list(DJIA_30))
    except Exception:
        return dict(news_sentiment.UNAVAILABLE_PAYLOAD)


# Deliberately sync `def`: FastAPI runs it in the threadpool, so the blocking
# requests.get inside the adapter cannot stall the event loop. Do NOT convert
# to `async def` without moving the HTTP call off the loop.
@router.get("/signals")
def latest_news_signals():
    # Single-flight lives in the cache primitive: one leader hits the producer,
    # concurrent callers return the cached value (or a brief UNAVAILABLE) WITHOUT
    # blocking a worker behind the ~10s upstream call — so a cold-cache burst of
    # Home polls can't starve the shared threadpool that also serves the
    # deadline-sensitive /api/v1/runs/* endpoints. A short negative-cache TTL
    # (vs TTL_NEWS) also lets the panel recover within ~30s of the producer
    # coming back instead of pinning "unavailable" for the full 420s.
    return shared_ttl_cache.get_or_fetch(
        CACHE_KEY_NEWS_SIGNALS,
        _fetch_panel,
        ttl_seconds=TTL_NEWS,
        negative_ttl_seconds=TTL_NEWS_UNAVAILABLE,
        is_negative=lambda payload: payload.get("status") == "unavailable",
        default=dict(news_sentiment.UNAVAILABLE_PAYLOAD),
    )

"""Free-form strategy prompts: store + share.

A strategy is a free-form natural-language trading prompt (typically generated
by the Discord bot from a chat) saved under a short share ``code``. The website
can display it (``GET /strategy?code=...``) and run it through the existing
backtest workflow (``POST /backtest/run`` with ``strategy_prompt``).

These routes live under ``/api`` and therefore bypass the anonymous-session
middleware (see ``middleware.is_api_route``); they are intentionally public so a
shared link works without a session.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from dashboard.backend.api.rate_limit import FixedWindowRateLimiter, client_key
from dashboard.backend.domain.strategies.repository import (
    create_strategy,
    get_strategy,
)

router = APIRouter(prefix="/strategies", tags=["strategies"])

# Public, unauthenticated write. Bound *naive* write abuse (unbounded rows) with
# a per-client write budget. Best-effort only (see rate_limit module): a public
# sharing endpoint can't be fully locked down without breaking shared links.
_create_rate_limiter = FixedWindowRateLimiter(max_events=30, window_seconds=3600)


class CreateStrategyBody(BaseModel):
    # max_length bounds per-row storage; the store also strips/validates non-empty.
    prompt: str = Field(
        min_length=1,
        max_length=5000,
        description="Free-form strategy prompt the agent will follow",
    )
    description: Optional[str] = Field(default=None, max_length=500)
    source: Optional[str] = Field(default=None, max_length=40)
    # Display-only attribution label (e.g. "discord:<id>"); NOT an auth control.
    owner: Optional[str] = Field(default=None, max_length=120)


def _share_base(request: Request) -> str:
    """Base URL for share links. Prefers PUBLIC_BASE_URL, else the request host."""
    env_base = os.getenv("PUBLIC_BASE_URL")
    base = env_base if env_base else str(request.base_url)
    return base.rstrip("/")


def _with_share_url(record: dict, request: Request) -> dict:
    out = dict(record)
    out["share_url"] = f"{_share_base(request)}/strategy?code={record['code']}"
    return out


@router.post("")
def create_strategy_endpoint(body: CreateStrategyBody, request: Request):
    """Store a free-form strategy prompt; returns its share code + URL.

    Plain ``def`` so the blocking SQLite write runs in FastAPI's threadpool
    rather than on the event loop.
    """
    if not _create_rate_limiter.allow(client_key(request)):
        raise HTTPException(
            status_code=429,
            detail="Too many strategies created recently; please try again later.",
        )
    try:
        record = create_strategy(
            prompt=body.prompt,
            description=body.description,
            source=body.source,
            owner=body.owner,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _with_share_url(record, request)


@router.get("/{code}")
def get_strategy_endpoint(code: str, request: Request):
    """Fetch a stored strategy by share code (for the viewer / backtest)."""
    record = get_strategy(code)
    if not record:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return _with_share_url(record, request)

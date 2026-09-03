"""Leaderboard baseline strategies — one strategy per module.

Each strategy is independent; shared price/equity helpers live in ``_common``.
Use ``get_strategy(config)`` to resolve a strategy from a config entry.

Canonical location (Phase 3C3). Moved verbatim from
``dashboard/backend/engines/strategies/``, which now re-exports from here.
"""

from .base import BaselineStrategy
from .registry import available_strategies, get_strategy

__all__ = ["BaselineStrategy", "get_strategy", "available_strategies"]

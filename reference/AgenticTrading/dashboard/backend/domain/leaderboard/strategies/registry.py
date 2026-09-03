"""Registry mapping config ``strategy`` keys to baseline strategy classes.

To add a new baseline: create a module in this package with a ``BaselineStrategy``
subclass, then register its class below. Nothing else needs to change.
"""

from __future__ import annotations

from typing import Any, Dict, Type

from .base import BaselineStrategy
from .buy_hold import BuyHoldStrategy
from .equal_weight_buyhold import EqualWeightBuyHoldStrategy
from .equal_weight_index import EqualWeightIndexStrategy
from .llm_agent import LLMAgentStrategy
from .market_index import MarketIndexStrategy
from .mean_variance import MeanVarianceStrategy

_STRATEGY_CLASSES = [
    BuyHoldStrategy,
    EqualWeightIndexStrategy,
    EqualWeightBuyHoldStrategy,
    MarketIndexStrategy,
    MeanVarianceStrategy,
    LLMAgentStrategy,
]

_REGISTRY: Dict[str, Type[BaselineStrategy]] = {cls.key: cls for cls in _STRATEGY_CLASSES}

# Backward-compatible aliases for the original config ``type`` values.
_ALIASES = {
    "index": "equal_weight_index",
    "buy_hold": "buy_hold",
}


def get_strategy(config: Dict[str, Any]) -> BaselineStrategy:
    """Instantiate the strategy for a leaderboard config entry."""
    key = config.get("strategy") or config.get("type")
    if key in _ALIASES:
        key = _ALIASES[key]
    cls = _REGISTRY.get(key)
    if cls is None:
        raise ValueError(
            f"Unknown baseline strategy '{key}'. Available: {sorted(_REGISTRY)}"
        )
    return cls(config)


def available_strategies() -> Dict[str, Type[BaselineStrategy]]:
    return dict(_REGISTRY)

"""Environment registry for the Agent-Environment Protocol.

An environment describes where an agent runs (asset class, frequency, action
schema, constraints). For this version only the existing hourly US-equity
backtest is exposed. The registry is intentionally data-driven so paper/live
environments can be added later without changing the Run API.

Moved verbatim (Phase 3B2) from ``dashboard/backend/environments.py``; the
original module was removed in Phase 4A. The ``ENVIRONMENTS`` registry, public
functions, and behavior are unchanged; only the module location moved.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from dashboard.backend.infrastructure.llm.validator import DJIA_30

ENVIRONMENTS: Dict[str, Dict[str, Any]] = {
    "us-equity-hourly-v1": {
        "environment_id": "us-equity-hourly-v1",
        "type": "backtest",
        "asset_class": "us_equity",
        "frequency": "1h",
        "supported_action_schema": "orders-v1",
        "supports_shorting": False,
        "universe": list(DJIA_30),
        "initial_cash": 1000,
        "constraints": {
            "allow_short": False,
            "max_position_weight": 0.25,
            "max_orders": 10,
            "min_confidence": 0.3,
        },
        "description": (
            "Hourly US-equity backtest over the DJIA 30 universe using Alpaca "
            "market data. Step cadence is one trading hour."
        ),
    }
}


def list_environments() -> List[Dict[str, Any]]:
    return list(ENVIRONMENTS.values())


def get_environment(environment_id: str) -> Optional[Dict[str, Any]]:
    return ENVIRONMENTS.get(environment_id)


def default_environment_id() -> str:
    return "us-equity-hourly-v1"

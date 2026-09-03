"""GET /api/v2/schema — self-describing contract (spec §4.1)."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from dashboard.backend.api.v2.errors import ERROR_CODES
from dashboard.backend.api.v2.models import (
    SCHEMA_VERSION, UNIVERSE, UNIVERSE_KEY, ActionItem, ContextEnvelope,
    DecisionRequest, ResultEnvelope, SubmitAck,
)
from dashboard.backend.api.v2.auth_scopes import SCOPES

router = APIRouter(prefix="/v2", tags=["v2-schema"])


def build_schema() -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "universe_key": UNIVERSE_KEY,
        "universe": UNIVERSE,
        "error_codes": ERROR_CODES,
        "scopes": SCOPES,
        "loops": ["lockstep", "realtime"],
        "verbs": {
            "register": "POST /api/v2/agents",
            "get_context": "GET /api/v2/runs/{run_id}/context",
            "submit_decision": "POST /api/v2/runs/{run_id}/decisions",
            "get_result": "GET /api/v2/runs/{run_id}/result",
        },
        "schemas": {
            "context": ContextEnvelope.model_json_schema(),
            "decision": DecisionRequest.model_json_schema(),
            "action": ActionItem.model_json_schema(),
            "submit_ack": SubmitAck.model_json_schema(),
            "result": ResultEnvelope.model_json_schema(),
        },
    }


@router.get("/schema")
async def get_schema():
    return build_schema()

"""Environment discovery API.

Canonical location (Phase 3B3). Moved verbatim from
``dashboard/backend/api/environments.py``, which is now a thin compatibility
re-export shim. Endpoint paths, methods, names, prefix, tags, response schemas,
status codes, and exception messages are unchanged; only the module location
moved.
"""

from fastapi import APIRouter, HTTPException

from dashboard.backend.domain.runs.environment import get_environment, list_environments

router = APIRouter(prefix="/v1/environments", tags=["environments"])


@router.get("")
async def api_list_environments():
    """List available environments."""
    return {"environments": list_environments()}


@router.get("/{environment_id}")
async def api_get_environment(environment_id: str):
    """Fetch metadata for a single environment."""
    env = get_environment(environment_id)
    if not env:
        raise HTTPException(status_code=404, detail="Environment not found")
    return env

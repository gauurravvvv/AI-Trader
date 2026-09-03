"""Root health-check route (Phase 3D4A).

Moved verbatim from ``dashboard/backend/app.py``. The external path ``/health``
is unchanged; this router is registered directly on the app (no ``/api`` prefix),
keeping it distinct from the ``/api/health`` route in ``dashboard.backend.api.health``.
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health():
    """Health check."""
    return {"status": "ok"}

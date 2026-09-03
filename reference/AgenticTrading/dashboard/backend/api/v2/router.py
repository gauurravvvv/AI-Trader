"""Compose the /api/v2 surface."""

from fastapi import APIRouter

from dashboard.backend.api.v2.agents import router as agents_router
from dashboard.backend.api.v2.leaderboard import router as leaderboard_router
from dashboard.backend.api.v2.runs import router as runs_router
from dashboard.backend.api.v2.schema import router as schema_router

v2_router = APIRouter()
v2_router.include_router(agents_router)
v2_router.include_router(runs_router)
v2_router.include_router(schema_router)
v2_router.include_router(leaderboard_router)

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def api_health():
    return {"status": "ok"}

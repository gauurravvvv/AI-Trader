"""Resolve DJIA / buy-and-hold baseline runs paired with an external backtest."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple


def _is_external_run(run: Dict[str, Any]) -> bool:
    return str(run.get("run_id", "")).startswith("ext_")


def resolve_baselines_for_run(
    ext_run: Dict[str, Any],
    session_runs: List[Dict[str, Any]],
) -> Tuple[Optional[str], Optional[str]]:
    """
    Return (djia_run_id, buyhold_run_id) for the given external run.

    Prefer persisted IDs on the run row; otherwise match baselines created
    in the same finalize window (same dates, created after this ext run and
    before the next external run in the session).
    """
    djia_id = ext_run.get("baseline_djia_run_id")
    buyhold_id = ext_run.get("baseline_buyhold_run_id")
    if djia_id and buyhold_id:
        return djia_id, buyhold_id

    ext_created = ext_run.get("created_at") or ""
    start_date = ext_run.get("start_date")
    end_date = ext_run.get("end_date")

    ext_runs = sorted(
        [r for r in session_runs if _is_external_run(r)],
        key=lambda r: r.get("created_at") or "",
    )
    next_ext_created = None
    for idx, run in enumerate(ext_runs):
        if run.get("run_id") == ext_run.get("run_id") and idx + 1 < len(ext_runs):
            next_ext_created = ext_runs[idx + 1].get("created_at")
            break

    def _pick(agent_name: str) -> Optional[str]:
        candidates = [
            r
            for r in session_runs
            if r.get("agent_name") == agent_name
            and r.get("start_date") == start_date
            and r.get("end_date") == end_date
            and (r.get("created_at") or "") >= ext_created
            and (next_ext_created is None or (r.get("created_at") or "") < next_ext_created)
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda r: r.get("created_at") or "")
        return candidates[0].get("run_id")

    return djia_id or _pick("DJIA"), buyhold_id or _pick("buy-and-hold")

"""MEDIUM #3/#8 follow-up — external run ids must be collision-resistant.

The finalized-run id is a PRIMARY KEY written with INSERT OR REPLACE. The old
``ext_<YYYYMMDD_HHMMSS>`` scheme collided for two runs finishing in the same
second, silently overwriting the earlier run (and, post plot-cache, serving its
stale chart forever / merging its decision log). A uuid suffix fixes that.
"""

import dashboard.backend.domain.backtesting.external_run_service as ers


def test_ext_run_ids_unique_despite_same_second():
    # 1000 rapid calls share wall-clock seconds; every id must still be distinct.
    ids = [ers._new_ext_run_id() for _ in range(1000)]
    assert len(set(ids)) == 1000
    # Prefix preserved (baseline_resolver keys off startswith("ext_")).
    assert all(i.startswith("ext_") for i in ids)


def test_all_timestamped_run_id_sites_use_uuid_suffix():
    """Every run_id minted from a second-resolution timestamp adds a uuid suffix.

    run_id is the agent_runs PRIMARY KEY written with INSERT OR REPLACE; a bare
    timestamp collides for runs finishing in the same second, silently
    overwriting the earlier run and (with the plot.png cache) serving a stale
    chart forever. Guards the engine, paper baselines, paper sessions, and the
    external run service against that regression.
    """
    from pathlib import Path
    backend = Path(ers.__file__).resolve().parents[2]  # dashboard/backend
    for rel in ("domain/backtesting/engine.py",
                "domain/backtesting/baselines/paper.py",
                "domain/trading/paper_session.py",
                "domain/backtesting/external_run_service.py"):
        src = (backend / rel).read_text(encoding="utf-8")
        assert "uuid.uuid4()" in src, f"{rel} mints run_ids without a uuid suffix"

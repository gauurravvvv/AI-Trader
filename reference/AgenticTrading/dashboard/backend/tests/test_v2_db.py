

from dashboard.backend.database import BacktestDatabase


def _db(tmp_path):
    return BacktestDatabase(db_path=tmp_path / "v2.db")


def test_idempotency_roundtrip(tmp_path):
    db = _db(tmp_path)
    assert db.get_idempotency("run_x", 0, "key-1") is None
    ack = {"accepted": True, "next_step": 1}
    db.put_idempotency("run_x", 0, "key-1", ack)
    assert db.get_idempotency("run_x", 0, "key-1") == ack
    # Replay with same key returns the original, does not overwrite
    db.put_idempotency("run_x", 0, "key-1", {"accepted": False})
    assert db.get_idempotency("run_x", 0, "key-1") == ack


def test_run_manifest_roundtrip(tmp_path):
    db = _db(tmp_path)
    manifest = {"agent_name": "a", "model_name": "m", "mode": "backtest"}
    db.insert_run_manifest("run_y", manifest)
    assert db.get_run_manifest("run_y") == manifest
    assert db.get_run_manifest("missing") is None


def test_decisions_store_context_ref(tmp_path):
    db = _db(tmp_path)
    db.insert_decisions("run_z", [{
        "step_index": 0, "timestamp": "2026-04-15T10:30:00+00:00",
        "decision_source": "external_agent", "actions_submitted": [],
        "actions_executed": 0, "context_ref": "sha256:abc",
    }])
    rows = db.get_decisions("run_z")
    assert rows[0]["context_ref"] == "sha256:abc"

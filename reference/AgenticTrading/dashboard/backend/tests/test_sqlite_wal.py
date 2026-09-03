"""WAL journal mode for the shared SQLite file (PR #67 H4 follow-up).

The protocol RunStore and the main BacktestDatabase share one SQLite file.
Under the default rollback journal, any writer blocks all readers for the
duration of the write — and finalize writes (equity series + trades) are
heavy. WAL lets readers proceed while one writer commits, which is the
actual concurrency shape here (request threads read while a backtest
finalizes). journal_mode=WAL is a persistent property of the database
file, so enabling it once at construction covers every later connection.
"""

import sqlite3

from dashboard.backend.database import BacktestDatabase
from dashboard.backend.domain.runs.repository import RunStore


def _journal_mode(db_path) -> str:
    conn = sqlite3.connect(str(db_path))
    try:
        (mode,) = conn.execute("PRAGMA journal_mode").fetchone()
    finally:
        conn.close()
    return str(mode).lower()


def test_backtest_database_enables_wal(tmp_path):
    db = BacktestDatabase(tmp_path / "wal_main.db")
    assert _journal_mode(db.db_path) == "wal"


def test_run_store_enables_wal(tmp_path):
    store = RunStore(tmp_path / "wal_store.db")
    assert _journal_mode(store.db_path) == "wal"


def test_wal_persists_when_both_layers_share_one_file(tmp_path):
    """Whichever layer initializes first, the shared file ends up in WAL."""
    path = tmp_path / "shared.db"
    BacktestDatabase(path)
    RunStore(path)
    assert _journal_mode(path) == "wal"


def test_backtest_database_connections_wait_for_locks(tmp_path):
    """Connections should wait (busy_timeout) instead of failing fast when a
    concurrent writer holds the lock — RunStore already does this; the main
    wrapper shares the same file."""
    db = BacktestDatabase(tmp_path / "wal_busy.db")
    conn = db._get_connection()
    try:
        (timeout_ms,) = conn.execute("PRAGMA busy_timeout").fetchone()
    finally:
        conn.close()
    assert int(timeout_ms) >= 5000


def test_wal_database_still_readable_and_writable(tmp_path):
    """Basic round-trip through the wrapper API under WAL."""
    db = BacktestDatabase(tmp_path / "wal_rw.db")
    db.insert_run(
        run_id="wal_test_run",
        session_id="wal-session",
        agent_name="wal-agent",
        mode="external",
        start_date="2025-01-01",
        end_date="2025-01-31",
        initial_equity=100000.0,
    )
    runs = db.get_runs_by_session("wal-session")
    assert [r["run_id"] for r in runs] == ["wal_test_run"]

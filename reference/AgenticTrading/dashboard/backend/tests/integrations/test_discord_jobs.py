"""Tests for Discord backtest job persistence."""

from pathlib import Path

from dashboard.backend.integrations.discord_jobs import (
    STATUS_NOTIFIED,
    STATUS_PENDING,
    STATUS_WATCHING,
    DiscordJobStore,
    get_job_store,
    reset_job_store_for_tests,
)


def test_job_store_create_get_update(tmp_path: Path):
    store = DiscordJobStore(tmp_path / "jobs.db")
    job = store.create_job(
        discord_user_id="42",
        channel_id=99,
        session_id="sess-1",
        label="e23badad",
        live_run_id="agent_20260722_abc",
        agent_id="builtin-1",
        agent_name="My Agent",
        share_url="https://example/s/e23badad",
        guild_id=7,
    )
    assert job.status == STATUS_PENDING
    assert job.job_id
    loaded = store.get(job.job_id)
    assert loaded is not None
    assert loaded.discord_user_id == "42"
    assert loaded.channel_id == 99
    assert loaded.live_run_id == "agent_20260722_abc"
    assert loaded.agent_name == "My Agent"

    store.update(job.job_id, status=STATUS_WATCHING)
    assert store.get(job.job_id).status == STATUS_WATCHING

    store.update(
        job.job_id,
        status=STATUS_NOTIFIED,
        run_id="agent_20260722_abc",
        notified_at=1.0,
    )
    done = store.get(job.job_id)
    assert done.status == STATUS_NOTIFIED
    assert done.run_id == "agent_20260722_abc"
    assert done.notified_at == 1.0


def test_list_open_excludes_notified(tmp_path: Path):
    store = DiscordJobStore(tmp_path / "jobs.db")
    open_job = store.create_job(
        discord_user_id="1",
        channel_id=2,
        session_id="s",
        label="a",
    )
    closed = store.create_job(
        discord_user_id="1",
        channel_id=2,
        session_id="s",
        label="b",
    )
    store.update(closed.job_id, status=STATUS_NOTIFIED, notified_at=1.0)
    open_ids = {j.job_id for j in store.list_open()}
    assert open_job.job_id in open_ids
    assert closed.job_id not in open_ids


def test_get_job_store_respects_env(tmp_path: Path, monkeypatch):
    reset_job_store_for_tests()
    path = tmp_path / "env_jobs.db"
    monkeypatch.setenv("DISCORD_JOBS_DB", str(path))
    store = get_job_store()
    job = store.create_job(
        discord_user_id="9",
        channel_id=1,
        session_id="s",
        label="x",
    )
    assert path.is_file()
    assert store.get(job.job_id) is not None
    reset_job_store_for_tests()

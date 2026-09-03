

from dashboard.backend.domain.backtesting.external_run_service import ExternalBacktestSession


def _session(**kw):
    defaults = dict(backtest_id="bt_x", session_id="sess_x", agent_name="a",
                    model_name="m", start_date="2026-04-15", end_date="2026-04-16")
    defaults.update(kw)
    return ExternalBacktestSession(**defaults)


def test_run_id_defaults_to_none_like_v1():
    s = _session()
    assert s.run_id is None
    assert s.context_ref_by_step == {}


def test_run_id_can_be_supplied():
    s = _session(run_id="run_canonical_1")
    assert s.run_id == "run_canonical_1"

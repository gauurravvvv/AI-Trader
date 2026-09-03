

import dashboard.backend.api.v2.runs as runs_mod
from dashboard.backend.tests._v2_fakes import FakeBackend


def test_replayed_key_returns_original_ack_no_double_execute():
    backend = FakeBackend(run_id="run_idem_1", session_id="sess_idem", total_steps=5)
    runs_mod.register_run("run_idem_1", backend, "sess_idem")

    first = runs_mod._submit_for("run_idem_1", "sess_idem", "same-key", [
        {"action": "buy", "symbol": "AAPL", "confidence": 0.8,
         "reasoning": "first submit", "position_size": 5}])
    step_after_first = backend.step_index

    replay = runs_mod._submit_for("run_idem_1", "sess_idem", "same-key", [
        {"action": "buy", "symbol": "MSFT", "confidence": 0.9,
         "reasoning": "should be ignored", "position_size": 9}])

    assert replay == first                 # original ack returned verbatim
    assert backend.step_index == step_after_first  # no second advance

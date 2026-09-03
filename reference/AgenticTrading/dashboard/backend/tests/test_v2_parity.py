

from dashboard.backend.api.v2.models import ContextEnvelope, ResultEnvelope, SubmitAck
from dashboard.backend.tests._v2_fakes import FakeBackend


def test_fake_backend_envelopes_validate_against_models():
    """Schema parity: a non-backtest backend's envelopes pass the same models."""
    backend = FakeBackend(run_id="run_fake_1")
    ctx = backend.build_context()
    ContextEnvelope.model_validate(ctx)

    ack = backend.apply_decisions([
        {"action": "buy", "symbol": "AAPL", "confidence": 0.8,
         "reasoning": "momentum looks strong", "position_size": 5},
    ])
    SubmitAck.model_validate(ack)

    # Drive to completion, then the result validates too.
    while backend.status()["status"] != "completed":
        backend.apply_decisions([])
    ResultEnvelope.model_validate(backend.result())

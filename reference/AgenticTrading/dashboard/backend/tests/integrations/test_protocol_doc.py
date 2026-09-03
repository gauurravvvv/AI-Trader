"""MEDIUM #9 — the Agent-Environment Protocol doc must match the impl.

Source-level guards (no server) so the doc can't drift back to describing a
phantom ``cancelled`` state or omitting error codes the routes actually emit.
"""

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]
_DOC = _REPO_ROOT / "docs" / "api" / "agent-environment-protocol-v1.md"


def _doc() -> str:
    return _DOC.read_text(encoding="utf-8")


def test_doc_has_no_phantom_cancelled_state():
    doc = _doc()
    # No route or service transition ever produces a cancelled run, so the state
    # machine must not advertise one.
    assert "→ cancelled" not in doc
    assert "running → cancelled" not in doc


def test_doc_error_table_documents_actually_emitted_codes():
    doc = _doc()
    # Codes the runs router / run service actually raise (via the error envelope).
    for code in ("run_not_found", "agent_version_not_found",
                 "too_many_orders", "decision_deadline_exceeded",
                 "unsupported_environment", "result_not_found",
                 "too_many_active_runs", "run_failed"):
        assert f"`{code}`" in doc, code
    # The runs router no longer emits `forbidden`: denied lookups collapse to
    # 404 (no existence oracle), so the doc must not advertise a 403 row.
    assert "| 403" not in doc

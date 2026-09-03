"""H8 — the dashboard must not show fabricated data to real users.

The frontend is vanilla JS with no test harness, so these are source-level guards
(read the files as text) that run in CI and lock the fix: MOCK_AGENTS may only
render in demo mode, an API outage shows a distinct error-state (not fake data),
and the mock "My Portfolio" carries a visible "Sample data" badge.
"""

from pathlib import Path

_FRONTEND = Path(__file__).resolve().parents[3] / "frontend"
_APP_JS = _FRONTEND / "app.js"
_APP_HTML = _FRONTEND / "app.html"


def test_mock_agents_are_demo_gated():
    src = _APP_JS.read_text(encoding="utf-8")
    assert "function isDemoMode(" in src
    # The empty-list fallback to MOCK_AGENTS is gated behind demo mode.
    assert "if (!agents.length && isDemoMode())" in src
    # Two gates: the empty-list fallback and the catch-block fallback.
    assert src.count("isDemoMode()") >= 2
    # The old unconditional empty-list swap is gone (normalize whitespace to be
    # robust to reformatting).
    normalized = " ".join(src.split())
    assert "if (!agents.length) { agents = MOCK_AGENTS; }" not in normalized


def test_api_failure_shows_error_state_not_mock():
    src = _APP_JS.read_text(encoding="utf-8")
    assert "function renderAgentsError(" in src
    assert "renderAgentsError()" in src
    # The old behavior — unconditionally swapping in mock data on failure — is gone.
    assert "using mock data" not in src


def test_html_has_error_state_and_sample_badge():
    html = _APP_HTML.read_text(encoding="utf-8")
    assert 'id="agentsErrorState"' in html          # distinct error-state element
    assert 'id="portfolioSampleBadge"' in html       # honest "Sample data" label
    assert "SAMPLE DATA" in html

"""H9 — docs must document a run command that actually works, and CLAUDE.md must
describe the package contract this branch introduced (not the flat-imports one).
"""

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]


def test_getting_started_uses_working_run_command():
    rst = (_REPO_ROOT / "docs" / "source" / "lab" / "getting_started.rst").read_text(encoding="utf-8")
    assert "uvicorn dashboard.backend.app:app" in rst
    # Running the file directly is broken (top-level dashboard.backend.* imports
    # need the repo root on sys.path) — it must not be the documented command.
    assert "python3 dashboard/backend/app.py" not in rst
    assert "python dashboard/backend/app.py" not in rst


def test_claude_md_documents_package_contract():
    claude = (_REPO_ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    assert "dashboard.backend" in claude
    assert "uvicorn dashboard.backend.app:app" in claude
    # Must not reinstate the flat-imports contract this branch removed.
    assert "flat top-level imports" not in claude

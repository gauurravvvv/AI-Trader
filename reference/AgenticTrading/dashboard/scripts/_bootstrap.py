"""Shared bootstrap for direct script execution.

Scripts under ``dashboard/scripts/`` import the backend through the canonical
package path (``from dashboard.backend.paths import ...``). When a script is run
directly as a file (``python dashboard/scripts/foo.py``), Python only puts the
script's own directory on ``sys.path`` — not the repository root — so the
``dashboard`` package would not be importable.

``ensure_repo_root()`` adds **only the repository root** to ``sys.path`` so that
``dashboard.backend.*`` resolves. It deliberately does NOT add
``dashboard/backend/`` to ``sys.path`` and creates no ``sys.modules`` aliases, so
there is a single canonical identity for every backend module.

When a script is imported/run as part of the package (the eventual end state),
the repo root is already importable and this is a harmless no-op.
"""

import os
import sys

# dashboard/scripts/_bootstrap.py -> repo root is three levels up.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def ensure_repo_root() -> None:
    """Ensure the repository root is on ``sys.path`` for canonical imports."""
    if _REPO_ROOT not in sys.path:
        sys.path.insert(0, _REPO_ROOT)

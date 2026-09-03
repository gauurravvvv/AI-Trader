"""Dashboard backend package.

Canonical import contract: all backend code is imported through
``dashboard.backend.*`` (e.g. ``from dashboard.backend.database import db``).

Canonical startup::

    uvicorn dashboard.backend.app:app --host 0.0.0.0 --port 8000

This package intentionally has NO import-path side effects. The Phase 1A
``sys.path`` bootstrap that previously lived here has been removed in Phase 1B
now that all modules use canonical absolute imports.
"""

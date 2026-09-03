"""Dashboard application namespace.

Phase 1A bootstrap: makes ``dashboard`` an importable package so the backend can
be started as ``uvicorn dashboard.backend.app:app`` from the repository root.

This package intentionally contains no logic. Business modules are NOT moved in
this phase.
"""

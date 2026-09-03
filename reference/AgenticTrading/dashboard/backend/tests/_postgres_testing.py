"""Shared safety guard for the live-Postgres (``@pg_only``) test tier.

The ``@pg_only`` fixtures run unconditional ``DELETE FROM`` against whatever
``TEST_POSTGRES_URL`` names. That variable is deliberately *not* stripped by
``conftest.py`` (it is how a developer opts into the live tier), so a plausible
``export TEST_POSTGRES_URL=$CONTENT_DATABASE_URL`` would point those deletes at
the production Neon database -- wiping every account, agent, and API key.

``require_local_postgres_url`` is the counterweight: the destructive fixtures
call it before touching the database, so a non-local URL fails loud rather than
silently wiping prod (or silently skipping).
"""

from urllib.parse import urlsplit

# CI uses localhost:5432; the documented local recipe uses localhost:5433.
# Every legitimate target is local, so an allowlist costs nothing.
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def require_local_postgres_url(url):
    """Return ``url`` if it is safe for the destructive @pg_only fixtures.

    Unset (``None``/``""``) passes through untouched -- that drives the skipif
    that skips the whole tier. A URL whose host is not in ``_LOCAL_HOSTS``
    raises ``RuntimeError``, refusing to let the fixtures ``DELETE`` from a
    remote (i.e. potentially production) database.
    """
    if not url:
        return url
    host = (urlsplit(url).hostname or "").lower()
    if host not in _LOCAL_HOSTS:
        raise RuntimeError(
            f"TEST_POSTGRES_URL points at non-local host {host!r}. The @pg_only "
            "fixtures run unconditional DELETEs and would wipe that database. "
            "Refusing to run them anywhere but localhost/127.0.0.1 -- use a "
            "throwaway Postgres (see the module docstring)."
        )
    return url

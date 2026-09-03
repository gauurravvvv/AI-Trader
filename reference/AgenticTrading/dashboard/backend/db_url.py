"""Describe a database URL for logging, without leaking its credentials.

Used by every store factory (users, agents, agent versions, strategies) to log
*which* Postgres it bound to rather than merely that it bound to "postgres". A
bare backend name cannot distinguish the intended Neon database from staging, or
from a URL with a typo'd host -- they produce byte-identical startup logs, which
is the failure shape CLAUDE.md's "Fail-closed is not fail-visible" section exists
to warn about. (The scoped CONTENT_/USERS_ names rule out an *accidental*
collision with another tool's env var; they do nothing about a wrong value
deliberately set.)

Defined once rather than cloned into each store module (this feature's pattern
everywhere else) because it is credential-scrubbing code: four hand-copied
scrubbers is four chances for one of them to leak a password into a log.
"""

from __future__ import annotations

from urllib.parse import urlsplit

# psycopg reads a connection string as a URL only when it starts with one of
# these; anything else is parsed as a keyword DSN. See require_postgres_url.
_POSTGRES_URL_SCHEMES = ("postgresql://", "postgres://")


def require_postgres_url(database_url: str) -> str:
    """Return ``database_url``, or raise if psycopg would read it as a keyword DSN.

    psycopg treats a connection string as a URL only when it starts with
    ``postgresql://`` or ``postgres://``. Anything else is parsed as a keyword
    DSN (``host=... password=...``) and the resulting ProgrammingError quotes
    the *entire* input back::

        missing "=" after ""postgresql://u:hunter2@ep-x.neon.tech/atl"" in
        connection info string

    The store factories construct their twin at import time with no try/except
    -- fail-loud is deliberate -- so that message *is* the boot failure, and it
    carries the live password into the deploy log. Every malformed shape
    observed leaks (a value pasted with wrapping quotes, an uppercase scheme,
    ``postgre://``, a single slash, a leading space, no scheme at all) and every
    well-formed one does not, so the scheme check is the exact boundary rather
    than a heuristic.

    Still fail-loud: a bad value raises here instead of reaching psycopg. The
    message quotes no part of the input, for the same reason
    describe_database_url echoes nothing it could not parse.
    """
    if not isinstance(database_url, str) or not database_url.startswith(
        _POSTGRES_URL_SCHEMES
    ):
        raise ValueError(
            "database URL must start with 'postgresql://' or 'postgres://'. "
            "Refusing to hand it to psycopg, which parses a non-URL as a "
            "keyword DSN and quotes the whole value -- password included -- "
            "into the error it raises. Check the env var for wrapping quotes "
            "or a typo'd scheme."
        )
    return database_url


def describe_database_url(database_url: str) -> str:
    """Return ``host[:port]/dbname`` for ``database_url``, never its credentials.

    Returns ``"?/?"`` for anything not parseable as a URL. That constant is
    deliberate: psycopg also accepts keyword/DSN strings (``host=... dbname=...
    password=...``), and urlsplit puts the *entire* such string -- password
    included -- in ``.path``. Echoing any part of unparseable input back into a
    log is exactly the leak this helper exists to prevent, so it echoes nothing.
    Prod uses a URL, so the degraded case costs only log detail.

    Never raises: this runs inside a factory at import time, and a log helper
    that explodes on an odd URL would take the whole app down with it.
    """
    try:
        parts = urlsplit(database_url)
        host = parts.hostname
        port = "" if parts.port is None else f":{parts.port}"
    except ValueError:
        # urlsplit, or .port on a non-integer port, rejected the input.
        return "?/?"
    if not host:
        return "?/?"
    dbname = parts.path.lstrip("/") or "?"
    # urlsplit strips the brackets from an IPv6 literal, and IPv6 addresses
    # are colon-delimited themselves, so an unbracketed "::1:5432" cannot be
    # read as host-vs-port. Restore them: an ambiguous line is not visibility.
    if ":" in host:
        host = f"[{host}]"
    return f"{host}{port}/{dbname}"

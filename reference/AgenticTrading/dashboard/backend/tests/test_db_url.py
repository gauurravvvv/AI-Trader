"""describe_database_url must name the target and never leak the credential.

It runs inside every store factory at import time, so it must also never raise:
a helper that explodes on an odd URL would take the app down to log a line.
"""

import pytest

from dashboard.backend.db_url import describe_database_url, require_postgres_url


def test_describes_host_port_and_dbname():
    described = describe_database_url(
        "postgresql://u:pw@ep-x-pooler.eu-central-1.aws.neon.tech:5432/atl?sslmode=require"
    )
    assert described == "ep-x-pooler.eu-central-1.aws.neon.tech:5432/atl"


def test_omits_port_when_the_url_has_none():
    assert describe_database_url("postgresql://fake/db") == "fake/db"


def test_never_leaks_the_password():
    described = describe_database_url("postgresql://admin:sup3r-s3cret@host/db")
    assert described == "host/db"
    assert "sup3r-s3cret" not in described


def test_keyword_dsn_degrades_without_echoing_its_input():
    # psycopg also accepts keyword/DSN strings, which urlsplit cannot read: it
    # dumps the whole string into .path. Echoing that back would put the
    # password straight into the log -- so unparseable input returns a constant.
    dsn = "host=ep-x.neon.tech dbname=atl password=sup3r-s3cret"
    described = describe_database_url(dsn)
    assert described == "?/?"
    assert "sup3r-s3cret" not in described


def test_empty_and_junk_inputs_do_not_raise():
    assert describe_database_url("") == "?/?"
    assert describe_database_url("postgresql://host:notaport/db") == "?/?"


def test_brackets_ipv6_hosts_so_host_and_port_stay_readable():
    # urlsplit strips the brackets from an IPv6 literal, and IPv6 addresses
    # are themselves colon-delimited -- so an unbracketed "::1:5432" cannot
    # be read by eye as host-vs-port, which defeats the only reason this
    # helper names the target at all.
    assert describe_database_url("postgresql://u:pw@[::1]:5432/db") == "[::1]:5432/db"


def test_reports_port_zero_rather_than_dropping_it():
    # A falsy check treats port 0 as "no port" and prints "host/db", which
    # reads identically to a URL that genuinely has no port.
    assert describe_database_url("postgresql://u:pw@host:0/db") == "host:0/db"


# ----------------------------------------------------------------------
# require_postgres_url: keep a malformed value away from psycopg.
#
# describe_database_url protects the *log line*. It cannot protect the
# *traceback*: psycopg reads a connection string as a URL only when it starts
# with postgresql:// or postgres://, parses anything else as a keyword DSN, and
# quotes the entire input -- password included -- in the error it raises. The
# factories construct their twin at import time with no try/except, so that
# error IS the boot failure and the password reaches the deploy log.
# ----------------------------------------------------------------------

# Every shape here was observed leaking the password out of a real
# psycopg.connect(); every shape in the accept-list below was observed not to.
# The scheme check is therefore the exact boundary, not an approximation.
_LEAKING_SHAPES = [
    pytest.param('"postgresql://u:pw@host/db"', id="wrapping quotes (.env paste)"),
    pytest.param("POSTGRESQL://u:pw@host/db", id="uppercase scheme"),
    pytest.param("postgre://u:pw@host/db", id="typo'd scheme"),
    pytest.param("postgresql:/u:pw@host/db", id="single slash"),
    pytest.param(" postgresql://u:pw@host/db", id="leading space"),
    pytest.param("u:pw@host/db", id="no scheme"),
    pytest.param("host=x dbname=y password=pw", id="keyword DSN"),
    pytest.param("", id="empty"),
    pytest.param(None, id="None"),
]


@pytest.mark.parametrize("database_url", _LEAKING_SHAPES)
def test_rejects_anything_psycopg_would_read_as_a_keyword_dsn(database_url):
    with pytest.raises(ValueError):
        require_postgres_url(database_url)


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql://u:pw@ep-x-pooler.neon.tech/atl?sslmode=require",
        "postgres://u:pw@host:5432/db",
        # Well-formed but broken in other ways: still psycopg's job to report,
        # and psycopg reports these WITHOUT echoing the DSN. Rejecting them here
        # would trade a real connection error for a misleading one.
        "postgresql://u:pw@127.0.0.1:1/nope?connect_timeout=2",
        "postgresql://u:pw@host:notaport/db",
    ],
)
def test_accepts_well_formed_urls_unchanged(database_url):
    assert require_postgres_url(database_url) is database_url


def test_the_rejection_does_not_echo_the_credential():
    # The whole point is to keep the value out of a traceback, so the guard's
    # own message must not put it back -- including via exception chaining.
    with pytest.raises(ValueError) as excinfo:
        require_postgres_url('"postgresql://admin:sup3r-s3cret@host/db"')
    assert "sup3r-s3cret" not in str(excinfo.value)
    assert "sup3r-s3cret" not in repr(excinfo.value)
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__context__ is None

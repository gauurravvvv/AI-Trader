"""CI must actually provide the live Postgres the @pg_only tier needs.

If the postgres service block is ever dropped from .github/workflows/ci.yml,
every @pg_only test silently reverts to skipping and CI stays green -- the
Postgres backends would then ship unexecuted, which is the exact failure this
tier exists to prevent. So the absence of the wiring is made loud, here.

Locally this test skips: a contributor without docker is expected, and their
@pg_only tests skipping is fine. It is only CI that must not skip them.
"""

import os

import pytest


@pytest.mark.skipif(
    not os.getenv("CI"), reason="asserts the CI wiring; local runs may skip @pg_only"
)
def test_ci_provides_a_live_postgres():
    assert os.getenv("TEST_POSTGRES_URL"), (
        "TEST_POSTGRES_URL is unset in CI, so every @pg_only test is silently "
        "skipping and the Postgres backends are untested. Restore the postgres "
        "service block in .github/workflows/ci.yml (backend-tests job)."
    )

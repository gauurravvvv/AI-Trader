

from dashboard.backend.api.v2.schema import build_schema


def test_schema_publishes_contract_metadata():
    s = build_schema()
    assert s["schema_version"] == "2.0"
    assert s["universe_key"] == "djia_30"
    assert "AAPL" in s["universe"]
    assert "rate_limited" in s["error_codes"]
    assert "decisions:write" in s["scopes"]
    assert "context" in s["schemas"] and "decision" in s["schemas"]

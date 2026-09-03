

from fastapi.testclient import TestClient

from dashboard.backend.app import app

client = TestClient(app)


def test_register_returns_key_session_and_scopes():
    r = client.post("/api/v2/agents", json={"name": "v2-agent", "model_name": "gpt-x"})
    assert r.status_code == 200
    body = r.json()
    assert body["api_key"].startswith("ag_")
    assert body["session_id"]
    assert "decisions:write" in body["scopes"]


def test_me_resolves_from_api_key():
    reg = client.post("/api/v2/agents", json={"name": "v2-agent-2"}).json()
    r = client.get("/api/v2/agents/me", headers={"X-API-Key": reg["api_key"]})
    assert r.status_code == 200
    body = r.json()
    assert body["agent_id"]
    assert body["session_id"] == reg["session_id"]
    assert set(body["scopes"]) >= {"context:read", "decisions:write"}


def test_me_without_key_is_unauthorized_envelope():
    r = client.get("/api/v2/agents/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_schema_route_is_live():
    r = client.get("/api/v2/schema")
    assert r.status_code == 200
    assert r.json()["schema_version"] == "2.0"

"""``/images/{file_name}`` must reject path-separator names like its siblings.

Every other static route in ``app.py`` refuses names containing "/" or "\\"
and containment-checks the resolved path; ``/images`` did neither (CodeQL
py/path-injection #46/#47). Starlette path params never match a decoded "/",
and on POSIX a backslash is an ordinary filename character — so the practical
gap is Windows checkouts — but the guard must be uniform, not platform-lucky.
"""

from fastapi.testclient import TestClient

from dashboard.backend import app as app_mod


def _client_with_frontend(tmp_path, monkeypatch):
    images = tmp_path / "images"
    images.mkdir()
    (images / "ok.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    # A literal backslash is a valid POSIX filename character, which lets this
    # test observe the guard's behavior without Windows path semantics.
    (images / "..\\..\\evil.png").write_bytes(b"not-an-image")
    monkeypatch.setattr(app_mod, "frontend_path", tmp_path)
    return TestClient(app_mod.app)


def test_images_serves_plain_names(tmp_path, monkeypatch):
    client = _client_with_frontend(tmp_path, monkeypatch)
    resp = client.get("/images/ok.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"


def test_images_rejects_separator_names_even_when_a_file_matches(tmp_path, monkeypatch):
    client = _client_with_frontend(tmp_path, monkeypatch)
    assert client.get("/images/..%5C..%5Cevil.png").status_code == 404

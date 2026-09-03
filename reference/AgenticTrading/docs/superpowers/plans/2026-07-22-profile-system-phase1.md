# Profile System Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Header profile dropdown with logout, change-password endpoint with other-session invalidation, NIST-style password policy, and avatar upload — per `docs/superpowers/specs/2026-07-22-profile-system-enhancements-design.md` Phase 1.

**Architecture:** Backend adds one shared validator module (`password_policy.py`), three auth routes (`change-password`, avatar PUT/DELETE), three store methods mirrored across the SQLite (`users.py`) and Postgres (`users_postgres.py`) twin stores, and a lazy `avatar` column migration. Frontend (vanilla JS, no build step) turns the header account button into a dropdown and extends the Account page with password-change and avatar controls; the client compresses avatars via canvas, the server re-validates (mime allowlist + magic numbers + 100 KB cap).

**Tech Stack:** FastAPI + Pydantic, sqlite3/psycopg, bcrypt (existing), vanilla JS + canvas. **No new dependencies.**

> **Review amendments (2026-07-22 infra review):** (1) change-password's other-session
> revocation is now **best-effort** — wrapped in `try/except` with a `print()` surface so a
> revocation failure can't mask an already-durable password change as a misleading 500
> (Task 3 route + one added test). (2) Documented the intentional fresh `.account-menu`
> class (Task 6) and the inline-data-URI avatar payload tradeoff (Task 4). The
> `window.refreshHomeModules` call in Task 6's `updateAuthUI` was verified **correct** — it
> is defined in `home-page.js` and exported to `window`, not dead code, so it stays.

## Global Constraints

- Work in the worktree `/mnt/d/github/atl-wt-profile`, branch `feat/profile-system`. Run all commands from that worktree root.
- Tests: `~/atl-venv` python. Run as `~/atl-venv/bin/python -m pytest dashboard/backend/tests/... -v`.
- Every new API route MUST be added to `EXPECTED_FULL_CONTRACT` in `dashboard/backend/tests/test_app_composition.py` in the same task that adds the route, or CI goes red.
- Every store change lands in BOTH `dashboard/backend/users.py` (SQLite) and `dashboard/backend/users_postgres.py` (Postgres) — the twin-store rule. Postgres behavioral tests are `@pg_only` (skip without `TEST_POSTGRES_URL`); never point `TEST_POSTGRES_URL` at a remote/prod URL.
- Diagnostics use `print()`, never `logging` (logger output is invisible under the deployed config).
- NEVER commit changes to `dashboard/storage/data/backtest.db` (or its `-wal`/`-shm` sidecars). If it shows in `git status`, restore it: `git checkout -- dashboard/storage/data/backtest.db`.
- Frontend files are versioned in `app.html` query params: bump `styles.css?v=53` → `v=54` and `app.js?v=20` → `v=21` in the task that first touches each (once only).
- Do not modify anything under `docs/source/` or other user-facing docs — tracked separately as follow-ups.

---

### Task 1: Password policy module + vendored blocklist

**Files:**
- Create: `dashboard/backend/password_policy.py`
- Create: `dashboard/backend/common_passwords.txt`
- Test: `dashboard/backend/tests/test_password_policy.py`

**Interfaces:**
- Produces: `validate_new_password(password: str, email: str) -> list[str]` (empty list = acceptable), constants `MIN_LENGTH = 8`, `MAX_LENGTH = 128`. Later tasks import from `dashboard.backend.password_policy`.

- [ ] **Step 1: Generate the blocklist file**

```bash
cd /mnt/d/github/atl-wt-profile
{
  echo "# Common-password blocklist for dashboard.backend.password_policy."
  echo "# Source: SecLists Passwords/Common-Credentials/xato-net-10-million-passwords-10000.txt"
  echo "# (danielmiessler/SecLists), filtered to entries of length >= 8, first 1000 kept."
  echo "# Lines starting with '#' and blank lines are ignored by the loader."
  curl -fsSL https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/xato-net-10-million-passwords-10000.txt \
    | awk 'length($0) >= 8' | head -1000
} > dashboard/backend/common_passwords.txt
wc -l dashboard/backend/common_passwords.txt   # expect 1004 (4 header lines + 1000 entries)
```

If the download fails (offline), STOP and report — do not hand-write a substitute list.

- [ ] **Step 2: Verify existing test fixtures don't collide with the list**

```bash
grep -x -i -e securepass1 -e securepass123 dashboard/backend/common_passwords.txt; echo "exit=$?"
```

Expected: no output, `exit=1` (not found). If found, STOP and report (the fixture passwords would need changing — do not silently edit the blocklist).

- [ ] **Step 3: Write the failing tests**

Create `dashboard/backend/tests/test_password_policy.py`:

```python
"""Unit tests for the shared new-password policy (NIST-style: length + blocklist + email rule)."""

from dashboard.backend.password_policy import MAX_LENGTH, MIN_LENGTH, validate_new_password


def test_accepts_reasonable_password():
    assert validate_new_password("correct-horse-battery", "alice@example.com") == []


def test_rejects_too_short():
    violations = validate_new_password("a" * (MIN_LENGTH - 1), "alice@example.com")
    assert any("at least" in v for v in violations)


def test_accepts_exact_min_length():
    assert validate_new_password("x7#kQp!z", "alice@example.com") == []


def test_rejects_too_long():
    violations = validate_new_password("a" * (MAX_LENGTH + 1), "alice@example.com")
    assert any("at most" in v for v in violations)


def test_rejects_blocklisted_password():
    # 'password1' is in every common-password top list and is >= 8 chars.
    violations = validate_new_password("password1", "alice@example.com")
    assert any("too common" in v for v in violations)


def test_blocklist_is_case_insensitive():
    violations = validate_new_password("PaSsWoRd1", "alice@example.com")
    assert any("too common" in v for v in violations)


def test_rejects_password_containing_email_local_part():
    violations = validate_new_password("xx-felixflying-99", "felixflying@example.com")
    assert any("email" in v for v in violations)


def test_email_rule_is_case_insensitive():
    violations = validate_new_password("XxFELIXFLYINGxx1", "felixflying@example.com")
    assert any("email" in v for v in violations)


def test_short_local_part_is_not_matched():
    # local part 'ab' (< 3 chars) must NOT trigger the email rule
    assert validate_new_password("tab-collab-99", "ab@example.com") == []


def test_empty_email_is_safe():
    assert validate_new_password("perfectly-fine-pw", "") == []


def test_multiple_violations_reported_together():
    violations = validate_new_password("bob", "bob4@example.com")
    assert len(violations) >= 1  # too short at minimum; must not raise
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_password_policy.py -v
```

Expected: FAIL/ERROR with `ModuleNotFoundError: No module named 'dashboard.backend.password_policy'`.

- [ ] **Step 5: Write the implementation**

Create `dashboard/backend/password_policy.py`:

```python
"""
Shared new-password policy (NIST 800-63B style: length + blocklist, no
composition rules). Applied wherever a NEW password is accepted: signup,
change-password, and (Phase 2) reset. Existing stored passwords are never
re-validated.
"""

from pathlib import Path

MIN_LENGTH = 8
MAX_LENGTH = 128

_BLOCKLIST_PATH = Path(__file__).parent / "common_passwords.txt"


def _load_blocklist() -> frozenset:
    entries = set()
    for line in _BLOCKLIST_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entries.add(line.lower())
    return frozenset(entries)


_BLOCKLIST = _load_blocklist()


def validate_new_password(password: str, email: str) -> list:
    """Return human-readable violations; empty list means acceptable."""
    violations = []
    if len(password) < MIN_LENGTH:
        violations.append(f"Password must be at least {MIN_LENGTH} characters.")
    if len(password) > MAX_LENGTH:
        violations.append(f"Password must be at most {MAX_LENGTH} characters.")
    if password.lower() in _BLOCKLIST:
        violations.append("That password is too common; pick something less guessable.")
    local_part = (email or "").split("@", 1)[0].strip().lower()
    if len(local_part) >= 3 and local_part in password.lower():
        violations.append("Password must not contain your email name.")
    return violations
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_password_policy.py -v
```

Expected: 11 passed. If `test_rejects_blocklisted_password` fails, check `grep -x password1 dashboard/backend/common_passwords.txt` — if genuinely absent from the generated file, replace the test's password with one that IS present (pick from `head -20` of the file's entries) rather than editing the list.

- [ ] **Step 7: Commit**

```bash
git add dashboard/backend/password_policy.py dashboard/backend/common_passwords.txt dashboard/backend/tests/test_password_policy.py
git commit -m "feat: add shared NIST-style password policy with vendored blocklist"
```

---

### Task 2: Enforce the policy at signup

**Files:**
- Modify: `dashboard/backend/api/auth.py` (SignupRequest + signup route)
- Test: `dashboard/backend/tests/test_auth.py` (append)

**Interfaces:**
- Consumes: `validate_new_password` from Task 1.
- Produces: signup returns HTTP 400 with joined violation text for weak passwords (was: 422 from Pydantic for short ones, nothing for common ones).

- [ ] **Step 1: Write the failing tests** — append to `dashboard/backend/tests/test_auth.py`:

```python
def test_signup_rejects_common_password(client):
    response = client.post(
        "/api/auth/signup",
        json={
            "email": "carol@example.com",
            "display_name": "Carol",
            "password": "password1",
        },
    )
    assert response.status_code == 400
    assert "too common" in response.json()["detail"]


def test_signup_rejects_short_password_with_readable_error(client):
    response = client.post(
        "/api/auth/signup",
        json={
            "email": "carol@example.com",
            "display_name": "Carol",
            "password": "short",
        },
    )
    assert response.status_code == 400
    assert "at least 8" in response.json()["detail"]


def test_signup_rejects_password_containing_email_name(client):
    response = client.post(
        "/api/auth/signup",
        json={
            "email": "carolyn@example.com",
            "display_name": "Carol",
            "password": "carolyn-trades-2026",
        },
    )
    assert response.status_code == 400
    assert "email" in response.json()["detail"]
```

- [ ] **Step 2: Run to verify failure**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_auth.py -v
```

Expected: the three new tests FAIL (`test_signup_rejects_short_password_with_readable_error` gets 422, the others 200); the four pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `dashboard/backend/api/auth.py`:

(a) Add the import (after the existing `from dashboard.backend.users import ...` line):

```python
from dashboard.backend.password_policy import validate_new_password
```

(b) In `SignupRequest`, change the password field from `Field(min_length=8, max_length=128)` to:

```python
    password: str = Field(min_length=1, max_length=128)
```

(min_length drops to 1 so short passwords reach the policy and get a readable 400 instead of a Pydantic 422; max_length=128 stays as a transport bound.)

(c) At the top of the `signup` route body (before `user_store.create_user`):

```python
    violations = validate_new_password(payload.password, payload.email)
    if violations:
        raise HTTPException(status_code=400, detail=" ".join(violations))
```

- [ ] **Step 4: Run to verify pass**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_auth.py dashboard/backend/tests/test_users_postgres.py -v
```

Expected: all pass (postgres tier skips without `TEST_POSTGRES_URL` — skips are fine).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/api/auth.py dashboard/backend/tests/test_auth.py
git commit -m "feat: enforce password policy at signup"
```

---

### Task 3: Change-password endpoint + session invalidation (SQLite store)

**Files:**
- Modify: `dashboard/backend/users.py` (two new `UserStore` methods)
- Modify: `dashboard/backend/api/auth.py` (request model + route)
- Modify: `dashboard/backend/tests/test_app_composition.py` (contract freeze)
- Test: `dashboard/backend/tests/test_auth.py` (append)

**Interfaces:**
- Consumes: `validate_new_password` (Task 1); `verify_password`, `hash_password` (existing in `users.py`).
- Produces: `UserStore.update_password(user_id: int, new_password: str) -> None`; `UserStore.delete_other_sessions(user_id: int, keep_token: Optional[str]) -> None`; route `POST /api/auth/change-password` → `{"status": "ok"}`. Task 5 mirrors both methods on `PostgresUserStore` with identical signatures.
- **Best-effort revocation (non-atomic by design):** `update_password` and `delete_other_sessions` are separate transactions in both twin stores. The route commits the password change first, then revokes other sessions inside a `try/except` — a revocation failure is surfaced via `print()` and the route still returns `{"status": "ok"}` (the password change is already durable; a 500 here would wrongly signal failure and make a retry hit "Current password is incorrect"). Other-session revocation is therefore defence-in-depth, not a hard guarantee.

- [ ] **Step 1: Write the failing tests** — append to `dashboard/backend/tests/test_auth.py`:

```python
def _signup_and_token(client, email="dave@example.com", password="orig-sturdy-pw-1"):
    response = client.post(
        "/api/auth/signup",
        json={"email": email, "display_name": "Dave", "password": password},
    )
    assert response.status_code == 200
    return response.json()["token"]


def test_change_password_happy_path(client):
    token = _signup_and_token(client)
    response = client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "orig-sturdy-pw-1", "new_password": "new-sturdy-pw-2"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

    # Old password no longer works; new one does.
    old_login = client.post(
        "/api/auth/login",
        json={"email": "dave@example.com", "password": "orig-sturdy-pw-1"},
    )
    assert old_login.status_code == 401
    new_login = client.post(
        "/api/auth/login",
        json={"email": "dave@example.com", "password": "new-sturdy-pw-2"},
    )
    assert new_login.status_code == 200


def test_change_password_requires_auth(client):
    response = client.post(
        "/api/auth/change-password",
        json={"current_password": "x-not-relevant", "new_password": "new-sturdy-pw-2"},
    )
    assert response.status_code == 401


def test_change_password_wrong_current(client):
    token = _signup_and_token(client, email="erin@example.com")
    response = client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "wrong-guess-1", "new_password": "new-sturdy-pw-2"},
    )
    assert response.status_code == 400
    assert "Current password is incorrect" in response.json()["detail"]


def test_change_password_rejects_weak_new_password(client):
    token = _signup_and_token(client, email="frank@example.com")
    response = client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "orig-sturdy-pw-1", "new_password": "password1"},
    )
    assert response.status_code == 400
    assert "too common" in response.json()["detail"]
    # And the old password still works (nothing was changed).
    login = client.post(
        "/api/auth/login",
        json={"email": "frank@example.com", "password": "orig-sturdy-pw-1"},
    )
    assert login.status_code == 200


def test_change_password_invalidates_other_sessions_keeps_current(client):
    token_a = _signup_and_token(client, email="gina@example.com")
    token_b = client.post(
        "/api/auth/login",
        json={"email": "gina@example.com", "password": "orig-sturdy-pw-1"},
    ).json()["token"]

    response = client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"current_password": "orig-sturdy-pw-1", "new_password": "new-sturdy-pw-2"},
    )
    assert response.status_code == 200

    # The session that changed the password survives; the other is revoked.
    me_a = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_a}"})
    assert me_a.status_code == 200
    me_b = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_b}"})
    assert me_b.status_code == 401


def test_change_password_revocation_failure_still_succeeds(client, monkeypatch, capsys):
    # The password write and the other-session revocation are two separate
    # transactions. If revocation raises, the (already-durable) password change
    # must still report success rather than a misleading 500. Patch at the CLASS
    # level so it fails regardless of which UserStore instance the route resolves
    # (the `client` fixture only reassigns users_module.user_store; api/auth.py may
    # still hold the original singleton binding). `UserStore` is already imported.
    token = _signup_and_token(client, email="quinn@example.com")

    def _boom(*args, **kwargs):
        raise RuntimeError("session store unavailable")

    monkeypatch.setattr(UserStore, "delete_other_sessions", _boom)

    response = client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "orig-sturdy-pw-1", "new_password": "new-sturdy-pw-2"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

    # The new password is live despite the revocation failure (change was durable).
    new_login = client.post(
        "/api/auth/login",
        json={"email": "quinn@example.com", "password": "new-sturdy-pw-2"},
    )
    assert new_login.status_code == 200

    # The failure is surfaced via print() (logger output is invisible in prod), not
    # swallowed silently. Assert on capsys, never caplog.
    assert "revocation failed" in capsys.readouterr().out
```

(`UserStore` is already imported at the top of `test_auth.py` — `from dashboard.backend.users import UserStore` — so no new import is needed.)

- [ ] **Step 2: Run to verify failure**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_auth.py -v -k change_password
```

Expected: all six FAIL — most with 404 (route doesn't exist); `test_change_password_requires_auth` may 404 too, and `test_change_password_revocation_failure_still_succeeds` errors at `monkeypatch.setattr(UserStore, "delete_other_sessions", …)` because that method doesn't exist until Step 3. Every not-the-expected-outcome counts as a valid red.

- [ ] **Step 3: Add the store methods** — in `dashboard/backend/users.py`, inside `class UserStore`, after `delete_session`:

```python
    def update_password(self, user_id: int, new_password: str) -> None:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(new_password), user_id),
        )
        conn.commit()
        conn.close()

    def delete_other_sessions(self, user_id: int, keep_token: Optional[str]) -> None:
        """Revoke every session for the user except keep_token (None = all)."""
        conn = self._get_connection()
        cursor = conn.cursor()
        if keep_token:
            cursor.execute(
                "DELETE FROM auth_sessions WHERE user_id = ? AND token != ?",
                (user_id, keep_token),
            )
        else:
            cursor.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
        conn.commit()
        conn.close()
```

- [ ] **Step 4: Add the route** — in `dashboard/backend/api/auth.py`:

(a) Extend the users import to include `verify_password`:

```python
from dashboard.backend.users import public_user, user_store, verify_password
```

(b) After `LoginRequest`, add:

```python
class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)
```

(c) After the `logout` route, add:

```python
@router.post("/change-password")
async def change_password(
    payload: ChangePasswordRequest,
    current_user: dict = Depends(get_current_user),
    authorization: Optional[str] = Header(default=None),
):
    if not verify_password(payload.current_password, current_user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    violations = validate_new_password(payload.new_password, current_user["email"])
    if violations:
        raise HTTPException(status_code=400, detail=" ".join(violations))
    user_store.update_password(current_user["id"], payload.new_password)
    # Best-effort: revoke every other session so a stolen token dies with the old
    # password. Deliberately NOT atomic with the update above -- the two are separate
    # transactions/connections in both twin stores. The password change is already
    # durable here; if revocation raises (e.g. a transient Postgres blip on the prod
    # pool), turning it into a 500 would wrongly tell the client the change failed and
    # make a retry hit "Current password is incorrect". So swallow + surface via
    # print() (logger output is invisible under the deployed config) and still
    # return ok. Revocation is defence-in-depth, not a hard guarantee.
    try:
        user_store.delete_other_sessions(
            current_user["id"], keep_token=_extract_bearer_token(authorization)
        )
    except Exception as exc:  # noqa: BLE001 -- password change already committed
        print(
            f"WARNING: change-password committed for user {current_user['id']} but "
            f"other-session revocation failed: {exc!r}"
        )
    return {"status": "ok"}
```

(Note: `get_current_user` returns the raw store row, which includes `password_hash` — that is what makes the direct `verify_password` call possible. `public_user()` is what strips it from responses.)

- [ ] **Step 5: Update the contract freeze** — in `dashboard/backend/tests/test_app_composition.py`, in `EXPECTED_FULL_CONTRACT`, after the line `("POST", "/api/auth/signup"),` add:

```python
    ("POST", "/api/auth/change-password"),
```

- [ ] **Step 6: Run to verify pass**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_auth.py dashboard/backend/tests/test_app_composition.py -v
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add dashboard/backend/users.py dashboard/backend/api/auth.py dashboard/backend/tests/test_auth.py dashboard/backend/tests/test_app_composition.py
git commit -m "feat: change-password endpoint with other-session invalidation"
```

---

### Task 4: Avatar — column, validation, endpoints (SQLite store)

**Files:**
- Modify: `dashboard/backend/users.py` (migration, `public_user`, `set_avatar`)
- Modify: `dashboard/backend/api/auth.py` (validator helper + PUT/DELETE routes)
- Modify: `dashboard/backend/tests/test_app_composition.py` (contract freeze)
- Test: `dashboard/backend/tests/test_auth.py` (append)

**Interfaces:**
- Produces: `UserStore.set_avatar(user_id: int, avatar: Optional[str]) -> Dict[str, Any]` (returns `public_user` shape); `public_user()` gains an `"avatar"` key (str data-URI or None); routes `PUT /api/auth/avatar` and `DELETE /api/auth/avatar`, both returning `{"user": {...}}`. Task 5 mirrors `set_avatar`; Tasks 6/8 consume `user.avatar` in the frontend.

> **Accepted tradeoff (payload size):** avatars are stored as ≤~137 KB base64 data URIs inline in the user row, so once set they ride **every** `/api/auth/me`, login, and signup response and the localStorage `auth-user` blob. This is a deliberate Phase-1 choice (the spec chose no object storage / no image lib for simplicity) and is fine at current scale; revisit (object storage + an `avatar_url`) only if auth responses become hot or avatars grow.

- [ ] **Step 1: Write the failing tests** — append to `dashboard/backend/tests/test_auth.py`:

```python
import base64

# JPEG magic bytes + padding. The server validates magic + base64 + size,
# not full image decode (no image library), so this is a sufficient payload.
_TINY_JPEG = base64.b64encode(b"\xff\xd8\xff" + b"\x00" * 32).decode("ascii")


def _avatar_uri(payload_b64=_TINY_JPEG, mime="image/jpeg"):
    return f"data:{mime};base64,{payload_b64}"


def test_avatar_put_and_delete_flow(client):
    token = _signup_and_token(client, email="hana@example.com")
    headers = {"Authorization": f"Bearer {token}"}

    put = client.put("/api/auth/avatar", headers=headers, json={"avatar": _avatar_uri()})
    assert put.status_code == 200
    assert put.json()["user"]["avatar"] == _avatar_uri()

    me = client.get("/api/auth/me", headers=headers)
    assert me.json()["user"]["avatar"] == _avatar_uri()

    delete = client.delete("/api/auth/avatar", headers=headers)
    assert delete.status_code == 200
    assert delete.json()["user"]["avatar"] is None


def test_avatar_requires_auth(client):
    assert client.put("/api/auth/avatar", json={"avatar": _avatar_uri()}).status_code == 401
    assert client.delete("/api/auth/avatar").status_code == 401


def test_avatar_rejects_unsupported_mime(client):
    token = _signup_and_token(client, email="iris@example.com")
    response = client.put(
        "/api/auth/avatar",
        headers={"Authorization": f"Bearer {token}"},
        json={"avatar": _avatar_uri(mime="image/svg+xml")},
    )
    assert response.status_code == 400


def test_avatar_rejects_magic_number_mismatch(client):
    token = _signup_and_token(client, email="jack@example.com")
    # Declared PNG, actual bytes JPEG.
    response = client.put(
        "/api/auth/avatar",
        headers={"Authorization": f"Bearer {token}"},
        json={"avatar": _avatar_uri(mime="image/png")},
    )
    assert response.status_code == 400
    assert "match" in response.json()["detail"]


def test_avatar_rejects_invalid_base64(client):
    token = _signup_and_token(client, email="kate@example.com")
    response = client.put(
        "/api/auth/avatar",
        headers={"Authorization": f"Bearer {token}"},
        json={"avatar": "data:image/jpeg;base64,!!!not-base64!!!"},
    )
    assert response.status_code == 400


def test_avatar_rejects_oversize(client):
    token = _signup_and_token(client, email="liam@example.com")
    # Valid JPEG magic, padded past 100 KB.
    big = base64.b64encode(
        b"\xff\xd8\xff" + b"\x00" * (101 * 1024)
    ).decode("ascii")
    response = client.put(
        "/api/auth/avatar",
        headers={"Authorization": f"Bearer {token}"},
        json={"avatar": _avatar_uri(payload_b64=big)},
    )
    assert response.status_code == 400
    assert "100 KB" in response.json()["detail"]


def test_signup_response_includes_avatar_field(client):
    response = client.post(
        "/api/auth/signup",
        json={"email": "mia@example.com", "display_name": "Mia", "password": "sturdy-enough-9"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["avatar"] is None
```

- [ ] **Step 2: Run to verify failure**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_auth.py -v -k avatar
```

Expected: all FAIL (404 route / missing `avatar` key).

- [ ] **Step 3: Store changes** — in `dashboard/backend/users.py`:

(a) In `_init_schema`, immediately after the `discord_user_id` lazy-migration block (reuse the already-fetched `columns` set):

```python
        if "avatar" not in columns:
            cursor.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
```

(b) In `public_user`, add to the returned dict (after the `"created_at"` entry):

```python
        "avatar": data.get("avatar"),
```

(c) In `class UserStore`, after `delete_other_sessions` (Task 3):

```python
    def set_avatar(self, user_id: int, avatar: Optional[str]) -> Dict[str, Any]:
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET avatar = ? WHERE id = ?", (avatar, user_id))
        conn.commit()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            raise ValueError("user_not_found")
        return public_user(row)
```

- [ ] **Step 4: API changes** — in `dashboard/backend/api/auth.py`:

(a) Add to the stdlib imports at the top:

```python
import base64
```

(b) After `ChangePasswordRequest`, add:

```python
AVATAR_MAX_DECODED_BYTES = 100 * 1024

# Declared mime -> required leading bytes. WebP is RIFF-framed, checked separately.
_AVATAR_MAGIC = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/png": b"\x89PNG\r\n\x1a\n",
}


class AvatarRequest(BaseModel):
    avatar: str = Field(min_length=1, max_length=200_000)


def _validate_avatar_data_uri(value: str) -> str:
    """Server-side avatar gate: allowlisted mime, valid base64, magic-number
    match, <= 100 KB decoded. Never trust the client's canvas pipeline."""
    mime = None
    payload = None
    for candidate in ("image/jpeg", "image/png", "image/webp"):
        prefix = f"data:{candidate};base64,"
        if value.startswith(prefix):
            mime = candidate
            payload = value[len(prefix):]
            break
    if mime is None:
        raise ValueError("Avatar must be a base64 data URI (JPEG, PNG, or WebP).")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except ValueError as exc:  # binascii.Error subclasses ValueError
        raise ValueError("Avatar data is not valid base64.") from exc
    if len(decoded) > AVATAR_MAX_DECODED_BYTES:
        raise ValueError("Avatar image must be 100 KB or smaller.")
    if mime == "image/webp":
        ok = len(decoded) >= 12 and decoded[:4] == b"RIFF" and decoded[8:12] == b"WEBP"
    else:
        ok = decoded.startswith(_AVATAR_MAGIC[mime])
    if not ok:
        raise ValueError("Avatar image bytes do not match the declared format.")
    return value
```

(c) After the `change_password` route, add:

```python
@router.put("/avatar")
async def set_avatar(payload: AvatarRequest, current_user: dict = Depends(get_current_user)):
    try:
        value = _validate_avatar_data_uri(payload.avatar)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    user = user_store.set_avatar(current_user["id"], value)
    return {"user": user}


@router.delete("/avatar")
async def delete_avatar(current_user: dict = Depends(get_current_user)):
    user = user_store.set_avatar(current_user["id"], None)
    return {"user": user}
```

- [ ] **Step 5: Update the contract freeze** — in `test_app_composition.py`'s `EXPECTED_FULL_CONTRACT`, after the `change-password` line added in Task 3:

```python
    ("PUT", "/api/auth/avatar"),
    ("DELETE", "/api/auth/avatar"),
```

- [ ] **Step 6: Run to verify pass**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_auth.py dashboard/backend/tests/test_app_composition.py -v
```

Expected: all pass. Also confirm the seed DB stayed clean: `git status --short dashboard/storage/` → no output (conftest points `DATABASE_PATH` at a temp file, so this should already hold; restore if not).

(CSP note: the spec's "verify `img-src` allows `data:`" item is already satisfied — `middleware.py:124` ships `img-src * data:`. No middleware change needed; nothing to do in this task.)

- [ ] **Step 7: Commit**

```bash
git add dashboard/backend/users.py dashboard/backend/api/auth.py dashboard/backend/tests/test_auth.py dashboard/backend/tests/test_app_composition.py
git commit -m "feat: avatar upload with server-side validation (SQLite store)"
```

---

### Task 5: Postgres twin — migrations, methods, @pg_only tests

**Files:**
- Modify: `dashboard/backend/users_postgres.py`
- Test: `dashboard/backend/tests/test_users_postgres.py` (append)

**Interfaces:**
- Consumes: method signatures fixed by Tasks 3–4: `update_password(user_id, new_password)`, `delete_other_sessions(user_id, keep_token)`, `set_avatar(user_id, avatar)`.
- Produces: `PostgresUserStore` behaviorally identical to `UserStore` for those methods.

- [ ] **Step 1: Write the failing tests** — append to `dashboard/backend/tests/test_users_postgres.py`:

```python
@pg_only
def test_change_password_and_avatar_postgres(pg_client, temp_postgres_store):
    signup = pg_client.post(
        "/api/auth/signup",
        json={"email": "nina@example.com", "display_name": "Nina", "password": "orig-sturdy-pw-1"},
    )
    assert signup.status_code == 200
    token_a = signup.json()["token"]
    token_b = pg_client.post(
        "/api/auth/login",
        json={"email": "nina@example.com", "password": "orig-sturdy-pw-1"},
    ).json()["token"]

    change = pg_client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"current_password": "orig-sturdy-pw-1", "new_password": "new-sturdy-pw-2"},
    )
    assert change.status_code == 200

    # Prove the write landed in Postgres and sessions were pruned there.
    user = temp_postgres_store.get_user_by_email("nina@example.com")
    from dashboard.backend.users import verify_password

    assert verify_password("new-sturdy-pw-2", user["password_hash"])
    assert pg_client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token_a}"}
    ).status_code == 200
    assert pg_client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token_b}"}
    ).status_code == 401

    # Avatar round-trip against the live Postgres store.
    import base64 as _b64

    tiny_jpeg = _b64.b64encode(b"\xff\xd8\xff" + b"\x00" * 32).decode("ascii")
    uri = f"data:image/jpeg;base64,{tiny_jpeg}"
    put = pg_client.put(
        "/api/auth/avatar",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"avatar": uri},
    )
    assert put.status_code == 200
    assert temp_postgres_store.get_user_by_email("nina@example.com")["avatar"] == uri

    delete = pg_client.delete(
        "/api/auth/avatar", headers={"Authorization": f"Bearer {token_a}"}
    )
    assert delete.status_code == 200
    assert temp_postgres_store.get_user_by_email("nina@example.com")["avatar"] is None


@pg_only
def test_avatar_column_lazy_migration_postgres():
    """A pre-avatar users table gains the column on next store init."""
    require_local_postgres_url(TEST_POSTGRES_URL)
    from dashboard.backend.users_postgres import PostgresUserStore

    store = PostgresUserStore(TEST_POSTGRES_URL)
    with store._get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("ALTER TABLE users DROP COLUMN IF EXISTS avatar")

    migrated = PostgresUserStore(TEST_POSTGRES_URL)  # re-init runs the lazy ALTER
    with migrated._get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'users' AND column_name = 'avatar'"
            )
            assert cur.fetchone() is not None
```

- [ ] **Step 2: Run the no-Postgres tier to confirm collection is clean**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_users_postgres.py -v
```

Expected: dispatch tests pass, `@pg_only` tests SKIP (that's the fail-open trap — a skip is NOT a pass; the live tier runs in CI where `TEST_POSTGRES_URL` is set). If a local throwaway Postgres is available (`docker run --rm -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=atl_test -p 5433:5432 postgres:18-alpine; export TEST_POSTGRES_URL=postgresql://postgres:test@localhost:5433/atl_test`), run the live tier and verify the new tests FAIL before implementing.

- [ ] **Step 3: Implement** — in `dashboard/backend/users_postgres.py`:

(a) In `_init_schema`, add `avatar TEXT` to the `CREATE TABLE IF NOT EXISTS users` column list (after `discord_user_id TEXT`), and add a lazy migration right after the existing `discord_user_id` `ALTER`:

```python
                cur.execute(
                    """
                    ALTER TABLE users
                    ADD COLUMN IF NOT EXISTS avatar TEXT
                    """
                )
```

(b) After `delete_session`, add the three methods:

```python
    def update_password(self, user_id: int, new_password: str) -> None:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET password_hash = %s WHERE id = %s",
                    (hash_password(new_password), user_id),
                )

    def delete_other_sessions(self, user_id: int, keep_token: Optional[str]) -> None:
        """Revoke every session for the user except keep_token (None = all)."""
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                if keep_token:
                    cur.execute(
                        "DELETE FROM auth_sessions WHERE user_id = %s AND token != %s",
                        (user_id, keep_token),
                    )
                else:
                    cur.execute(
                        "DELETE FROM auth_sessions WHERE user_id = %s", (user_id,)
                    )

    def set_avatar(self, user_id: int, avatar: Optional[str]) -> Dict[str, Any]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET avatar = %s WHERE id = %s RETURNING *",
                    (avatar, user_id),
                )
                row = cur.fetchone()
        if not row:
            raise ValueError("user_not_found")
        return public_user(row)
```

- [ ] **Step 4: Run to verify**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/test_users_postgres.py -v
```

Expected: pass (or skip if no `TEST_POSTGRES_URL`; with the docker Postgres from Step 2, all pass live).

- [ ] **Step 5: Commit**

```bash
git add dashboard/backend/users_postgres.py dashboard/backend/tests/test_users_postgres.py
git commit -m "feat: mirror password/avatar store methods on Postgres twin"
```

---

### Task 6: Header account dropdown (frontend)

**Files:**
- Modify: `dashboard/frontend/app.html` (header block ~line 145–150; bump `styles.css?v=53`→`v=54` and `app.js?v=20`→`v=21` at lines 12 and 1497)
- Modify: `dashboard/frontend/app.js` (`updateAuthUI` ~line 1563, `initAuthUI` ~line 1783, new helpers)
- Modify: `dashboard/frontend/styles.css` (append)

**Interfaces:**
- Consumes: `user.avatar` from Task 4's API payloads (null-safe: renders initials when absent).
- Produces: element IDs `accountMenuWrap`, `accountMenu`, `authAvatar`, `accountMenuName`, `accountMenuEmail`, `accountMenuAccountBtn`, `accountMenuLogoutBtn`; JS helpers `renderAvatar(el, user)`, `toggleAccountMenu(force)`, `closeAccountMenu()` (Task 8 reuses `renderAvatar`).

- [ ] **Step 1: Replace the header account block** — in `app.html`, replace:

```html
            <div id="authControls" class="header-account">
                <button id="authSignInBtn" class="auth-btn auth-btn-primary" type="button">Sign in</button>
                <button id="authAccountBtn" class="auth-account-btn" type="button" hidden aria-label="Account">
                    <span id="authUserLabel" class="auth-user-label"></span>
                </button>
            </div>
```

with:

```html
            <div id="authControls" class="header-account">
                <button id="authSignInBtn" class="auth-btn auth-btn-primary" type="button">Sign in</button>
                <div id="accountMenuWrap" class="account-menu-wrap" hidden>
                    <button id="authAccountBtn" class="auth-account-btn" type="button" aria-label="Account menu" aria-haspopup="true" aria-expanded="false">
                        <span id="authAvatar" class="auth-avatar" aria-hidden="true"></span>
                        <span id="authUserLabel" class="auth-user-label"></span>
                        <span class="auth-caret" aria-hidden="true">▾</span>
                    </button>
                    <div id="accountMenu" class="account-menu" hidden>
                        <div class="account-menu-identity">
                            <span id="accountMenuName" class="account-menu-name"></span>
                            <span id="accountMenuEmail" class="account-menu-email"></span>
                        </div>
                        <button id="accountMenuAccountBtn" class="account-menu-item" type="button">Account</button>
                        <button id="accountMenuLogoutBtn" class="account-menu-item account-menu-item--danger" type="button">Log out</button>
                    </div>
                </div>
            </div>
```

Also bump the two cache params: line 12 `styles.css?v=53` → `styles.css?v=54`; line ~1497 `app.js?v=20` → `app.js?v=21`.

- [ ] **Step 2: Append styles** — at the end of `dashboard/frontend/styles.css`:

> Note: this defines a **fresh** `.account-menu` component rather than reusing the visually-similar `.agent-menu-dropdown` (which spec §1 suggested). Intentional — the account dropdown is a distinct component, and coupling it to the agent-menu class would let future agent-menu tweaks silently reshape the account menu. The small CSS overlap is the accepted cost.

```css
/* Header account dropdown */
.account-menu-wrap {
    position: relative;
}

.auth-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    overflow: hidden;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-hover);
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 700;
}

.auth-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.auth-caret {
    font-size: 10px;
    color: var(--text-secondary);
}

.account-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 60;
    min-width: 200px;
    padding: 6px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: var(--bg-surface);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.account-menu[hidden] {
    display: none !important;
}

.account-menu-identity {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-color);
    margin-bottom: 4px;
}

.account-menu-name {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-primary);
}

.account-menu-email {
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-all;
}

.account-menu-item {
    display: block;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
}

.account-menu-item:hover {
    background: var(--bg-hover);
}

.account-menu-item--danger {
    color: #f87171;
}
```

- [ ] **Step 3: JS — helpers + updateAuthUI** — in `app.js`, add above `updateAuthUI` (~line 1563):

```javascript
function renderAvatar(el, user) {
  if (!el) return;
  el.innerHTML = '';
  if (user && user.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;   // server-validated data: URI
    img.alt = '';
    el.appendChild(img);
  } else {
    const source = ((user && (user.display_name || user.email)) || '?').trim();
    el.textContent = source ? source[0].toUpperCase() : '?';
  }
}

function toggleAccountMenu(force) {
  const menu = document.getElementById('accountMenu');
  const btn = document.getElementById('authAccountBtn');
  if (!menu || !btn) return;
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeAccountMenu() {
  toggleAccountMenu(false);
}
```

Then replace the body of `updateAuthUI` with:

```javascript
function updateAuthUI() {
  const user = getStoredAuthUser();
  const label = document.getElementById('authUserLabel');
  const signInBtn = document.getElementById('authSignInBtn');
  const menuWrap = document.getElementById('accountMenuWrap');
  if (!signInBtn || !menuWrap) {
    return;
  }

  if (user) {
    if (label) label.textContent = user.display_name || user.email;
    signInBtn.hidden = true;
    menuWrap.hidden = false;
    renderAvatar(document.getElementById('authAvatar'), user);
    const nameEl = document.getElementById('accountMenuName');
    const emailEl = document.getElementById('accountMenuEmail');
    if (nameEl) nameEl.textContent = user.display_name || '—';
    if (emailEl) emailEl.textContent = user.email || '';
  } else {
    if (label) label.textContent = '';
    signInBtn.hidden = false;
    menuWrap.hidden = true;
    closeAccountMenu();
  }

  updateAccountPage();

  if (typeof window.refreshHomeModules === 'function') {
    window.refreshHomeModules();
  }
}
```

- [ ] **Step 4: JS — wire the menu in initAuthUI** — in `initAuthUI` (~line 1783), replace:

```javascript
  accountBtn?.addEventListener('click', () => navigateToPage('account'));
```

with:

```javascript
  accountBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAccountMenu();
  });
  document.getElementById('accountMenuAccountBtn')?.addEventListener('click', () => {
    closeAccountMenu();
    navigateToPage('account');
  });
  document.getElementById('accountMenuLogoutBtn')?.addEventListener('click', () => {
    closeAccountMenu();
    logoutUser();
  });
  document.addEventListener('click', (event) => {
    const wrap = document.getElementById('accountMenuWrap');
    if (wrap && !wrap.hidden && !wrap.contains(event.target)) {
      closeAccountMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAccountMenu();
    }
  });
```

- [ ] **Step 5: Manual verification**

```bash
~/atl-venv/bin/python -m uvicorn dashboard.backend.app:app --port 8000
```

In a browser (or Playwright) at `http://localhost:8000/app`: sign up a fresh user → header shows initials circle + name + caret; click toggles the menu; menu shows name/email, Account navigates, outside-click and Escape close it, Log out signs out and the Sign in button returns. Then STOP the server and check `git status --short dashboard/storage/` — restore the seed DB if the local run dirtied it (`git checkout -- dashboard/storage/data/backtest.db`).

- [ ] **Step 6: Run the backend suite (regression gate) and commit**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/ -q
git add dashboard/frontend/app.html dashboard/frontend/app.js dashboard/frontend/styles.css
git commit -m "feat: header account dropdown with logout"
```

---

### Task 7: Account page — change password form + live policy feedback

**Files:**
- Modify: `dashboard/frontend/app.html` (account view, ~line 1471–1488)
- Modify: `dashboard/frontend/app.js` (AuthAPI + form wiring)
- Modify: `dashboard/frontend/styles.css` (append)

**Interfaces:**
- Consumes: `POST /api/auth/change-password` (Task 3).
- Produces: `localPasswordViolations(password, email)` helper (reused for signup live feedback); element IDs `changePasswordForm`, `currentPasswordInput`, `newPasswordInput`, `confirmPasswordInput`, `passwordPolicyHints`, `changePasswordError`, `changePasswordSuccess`.

- [ ] **Step 1: Account page HTML** — in `app.html`, inside `#accountSignedIn`, after the `.account-actions` div, add:

```html
            <div class="account-section">
                <h3 class="account-section-title">Change password</h3>
                <form id="changePasswordForm" class="auth-form account-password-form">
                    <label class="auth-field">
                        <span>Current password</span>
                        <input id="currentPasswordInput" type="password" autocomplete="current-password" required>
                    </label>
                    <label class="auth-field">
                        <span>New password</span>
                        <input id="newPasswordInput" type="password" autocomplete="new-password" required>
                    </label>
                    <label class="auth-field">
                        <span>Confirm new password</span>
                        <input id="confirmPasswordInput" type="password" autocomplete="new-password" required>
                    </label>
                    <ul id="passwordPolicyHints" class="password-policy-hints" hidden></ul>
                    <p id="changePasswordError" class="auth-error" hidden></p>
                    <p id="changePasswordSuccess" class="account-success" hidden>Password updated. Other devices were signed out.</p>
                    <button class="auth-btn auth-btn-primary" type="submit">Update password</button>
                </form>
            </div>
```

- [ ] **Step 2: Styles** — append to `styles.css`:

```css
/* Account page — password + avatar sections */
.account-section {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border-color);
}

.account-section-title {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
}

.account-password-form {
    max-width: 360px;
}

.password-policy-hints {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 11px;
    color: #fbbf24;
}

.account-success {
    font-size: 12px;
    color: #34d399;
}
```

- [ ] **Step 3: JS — AuthAPI method + helpers + wiring** — in `app.js`:

(a) In the `AuthAPI` object, after `logout()`, add:

```javascript
  changePassword(currentPassword, newPassword) {
    return this.request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  },
```

(b) Near `renderAvatar` (Task 6), add:

```javascript
// Mirrors password_policy.py's length + email rules for live feedback.
// The blocklist rule is server-only; its violation surfaces on submit.
function localPasswordViolations(password, email) {
  const violations = [];
  if (password.length < 8) violations.push('At least 8 characters.');
  if (password.length > 128) violations.push('At most 128 characters.');
  const localPart = (email || '').split('@')[0].trim().toLowerCase();
  if (localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
    violations.push('Must not contain your email name.');
  }
  return violations;
}

function renderPolicyHints(listEl, violations) {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!violations.length) {
    listEl.hidden = true;
    return;
  }
  violations.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    listEl.appendChild(li);
  });
  listEl.hidden = false;
}

function initChangePasswordForm() {
  const form = document.getElementById('changePasswordForm');
  if (!form) return;
  const newInput = document.getElementById('newPasswordInput');
  const hints = document.getElementById('passwordPolicyHints');
  const errorEl = document.getElementById('changePasswordError');
  const successEl = document.getElementById('changePasswordSuccess');

  newInput?.addEventListener('input', () => {
    const user = getStoredAuthUser();
    renderPolicyHints(hints, localPasswordViolations(newInput.value, user?.email));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = document.getElementById('currentPasswordInput')?.value;
    const next = newInput?.value;
    const confirm = document.getElementById('confirmPasswordInput')?.value;
    if (errorEl) errorEl.hidden = true;
    if (successEl) successEl.hidden = true;

    if (next !== confirm) {
      if (errorEl) {
        errorEl.textContent = 'New password and confirmation do not match.';
        errorEl.hidden = false;
      }
      return;
    }
    try {
      await AuthAPI.changePassword(current, next);
      form.reset();
      renderPolicyHints(hints, []);
      if (successEl) successEl.hidden = false;
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
      }
    }
  });
}
```

(c) In `initAuthUI`, before the final `refreshAuthUser();` line, add:

```javascript
  initChangePasswordForm();
```

(d) Signup modal live feedback — in `initAuthUI`, alongside the other listeners, add:

```javascript
  document.getElementById('authPassword')?.addEventListener('input', (event) => {
    if (authMode !== 'signup') return;
    const email = document.getElementById('authEmail')?.value || '';
    let hints = document.getElementById('authPasswordHints');
    if (!hints) {
      hints = document.createElement('ul');
      hints.id = 'authPasswordHints';
      hints.className = 'password-policy-hints';
      event.target.closest('.auth-field')?.after(hints);
    }
    renderPolicyHints(hints, localPasswordViolations(event.target.value, email));
  });
```

- [ ] **Step 4: Manual verification**

Restart uvicorn; on the Account page: mismatch confirm → inline error; weak new password shows live hints while typing; `password1` as new password → server error "too common" surfaces; a valid change succeeds, shows the success line, and the old password fails on next login while the current tab stays signed in. Check the signup modal shows live hints in signup mode. Stop server; restore seed DB if dirtied.

- [ ] **Step 5: Commit**

```bash
git add dashboard/frontend/app.html dashboard/frontend/app.js dashboard/frontend/styles.css
git commit -m "feat: account page change-password form with live policy hints"
```

---

### Task 8: Account page — avatar upload with client-side compression

**Files:**
- Modify: `dashboard/frontend/app.html` (account view)
- Modify: `dashboard/frontend/app.js` (AuthAPI methods, compression, wiring, `updateAccountPage`)
- Modify: `dashboard/frontend/styles.css` (append)

**Interfaces:**
- Consumes: `PUT/DELETE /api/auth/avatar` (Task 4), `renderAvatar` (Task 6).
- Produces: avatar visible in header dropdown + account page immediately after upload.

- [ ] **Step 1: Account page HTML** — in `app.html`, inside `#accountSignedIn`, immediately BEFORE the change-password `.account-section` from Task 7, add:

```html
            <div class="account-section">
                <h3 class="account-section-title">Profile photo</h3>
                <div class="account-avatar-row">
                    <span id="accountAvatarPreview" class="auth-avatar auth-avatar--large" aria-hidden="true"></span>
                    <div class="account-avatar-actions">
                        <input id="avatarFileInput" type="file" accept="image/jpeg,image/png,image/webp" hidden>
                        <button id="avatarUploadBtn" class="auth-btn auth-btn-secondary" type="button">Upload photo</button>
                        <button id="avatarRemoveBtn" class="auth-btn auth-btn-secondary" type="button" hidden>Remove</button>
                    </div>
                </div>
                <p id="avatarError" class="auth-error" hidden></p>
            </div>
```

- [ ] **Step 2: Styles** — append to `styles.css`:

```css
.auth-avatar--large {
    width: 56px;
    height: 56px;
    font-size: 22px;
}

.account-avatar-row {
    display: flex;
    align-items: center;
    gap: 12px;
}

.account-avatar-actions {
    display: flex;
    gap: 8px;
}
```

- [ ] **Step 3: JS** — in `app.js`:

(a) In `AuthAPI`, after `changePassword`:

```javascript
  setAvatar(dataUri) {
    return this.request('/api/auth/avatar', {
      method: 'PUT',
      body: JSON.stringify({ avatar: dataUri }),
    });
  },

  removeAvatar() {
    return this.request('/api/auth/avatar', { method: 'DELETE' });
  },
```

(b) Near `renderAvatar`, add:

```javascript
const AVATAR_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const AVATAR_MAX_OUTPUT_BYTES = 100 * 1024;

async function compressAvatar(file) {
  if (file.size > AVATAR_MAX_INPUT_BYTES) {
    throw new Error('Image is too large (max 10 MB).');
  }
  const bitmap = await createImageBitmap(file);
  const MAX_DIM = 256;
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  for (const quality of [0.85, 0.6]) {
    const dataUri = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const decodedBytes = Math.floor(base64.length * 3 / 4);
    if (decodedBytes <= AVATAR_MAX_OUTPUT_BYTES) return dataUri;
  }
  throw new Error('Could not compress the image under 100 KB. Try a simpler image.');
}

function applyUpdatedUser(user) {
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  window.AUTH_USER = user;
  updateAuthUI();
}

function initAvatarControls() {
  const fileInput = document.getElementById('avatarFileInput');
  const uploadBtn = document.getElementById('avatarUploadBtn');
  const removeBtn = document.getElementById('avatarRemoveBtn');
  const errorEl = document.getElementById('avatarError');
  if (!fileInput || !uploadBtn) return;

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (errorEl) errorEl.hidden = true;
    uploadBtn.disabled = true;
    try {
      const dataUri = await compressAvatar(file);
      const data = await AuthAPI.setAvatar(dataUri);
      applyUpdatedUser(data.user);
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
      }
    } finally {
      uploadBtn.disabled = false;
    }
  });

  removeBtn?.addEventListener('click', async () => {
    if (errorEl) errorEl.hidden = true;
    removeBtn.disabled = true;
    try {
      const data = await AuthAPI.removeAvatar();
      applyUpdatedUser(data.user);
    } catch (error) {
      if (errorEl) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
      }
    } finally {
      removeBtn.disabled = false;
    }
  });
}
```

(c) In `updateAccountPage`, inside the `if (user) {` branch (after the email line), add:

```javascript
    renderAvatar(document.getElementById('accountAvatarPreview'), user);
    const removeBtn = document.getElementById('avatarRemoveBtn');
    if (removeBtn) removeBtn.hidden = !user.avatar;
```

(d) In `initAuthUI`, next to `initChangePasswordForm();`, add:

```javascript
  initAvatarControls();
```

- [ ] **Step 4: Manual verification**

Restart uvicorn. Upload a large photo → header avatar + account preview update immediately; Remove restores initials; a >10 MB file errors without a network call; non-image file errors cleanly. Refresh the page → avatar persists (served from `/auth/me`). Stop server; restore seed DB if dirtied.

- [ ] **Step 5: Commit**

```bash
git add dashboard/frontend/app.html dashboard/frontend/app.js dashboard/frontend/styles.css
git commit -m "feat: avatar upload with client-side compression"
```

---

### Task 9: Final verification + PR

- [ ] **Step 1: Full suite**

```bash
~/atl-venv/bin/python -m pytest dashboard/backend/tests/ -q
```

Expected: 0 failures (skips for `@pg_only`/optional deps are fine). Any failure is a real regression — fix before proceeding.

- [ ] **Step 2: Seed DB + workspace check**

```bash
git status --short
git diff origin/main --stat -- dashboard/storage/
```

Expected: no `dashboard/storage/` changes staged or committed anywhere on the branch. If the seed DB was committed in any earlier task commit, STOP and report (history rewrite needed — do not attempt it unsupervised).

- [ ] **Step 3: Playwright end-to-end walkthrough** (as PR #165 did): signup with weak password (blocked with hints) → strong password succeeds → dropdown open/close/Escape → avatar upload → password change → logout from dropdown → login with new password. Capture screenshots of the dropdown and account page for the PR body.

- [ ] **Step 4: Rebase check + push + PR**

If PR #165 has merged, rebase onto fresh `main` and re-run the suite before pushing:

```bash
git fetch origin main && git rebase origin/main && ~/atl-venv/bin/python -m pytest dashboard/backend/tests/ -q
```

Push and open the PR (title: `feat: profile dropdown, password policy + change, avatar`), body: short summary + screenshots + note that Phase 2 (email reset) is spec'd but gated on email-provider signup. Do NOT self-merge.

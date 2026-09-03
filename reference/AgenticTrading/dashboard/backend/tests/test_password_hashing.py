"""
Password hashing boundary tests.

bcrypt hashes only the first 72 bytes of a secret and drops the rest without an
error, while password_policy accepts up to 128 characters. `_bcrypt_secret` folds
over-cap secrets into a digest so no byte is silently ignored (NIST 800-63B
5.1.1.2). These tests pin that boundary, plus both legacy verify paths.
"""

import bcrypt
import pytest

from dashboard.backend import users as users_module
from dashboard.backend.password_policy import MAX_LENGTH
from dashboard.backend.users import (
    BCRYPT_MAX_BYTES,
    _bcrypt_secret,
    hash_password,
    verify_password,
)


@pytest.fixture(autouse=True)
def fast_bcrypt(monkeypatch):
    """bcrypt at the production 12 rounds costs ~250ms per hash; 4 is enough here."""
    monkeypatch.setattr(users_module, "BCRYPT_ROUNDS", 4)


def test_round_trip_and_rejects_wrong_password():
    stored = hash_password("correct-horse-battery")
    assert verify_password("correct-horse-battery", stored) is True
    assert verify_password("correct-horse-batteru", stored) is False


def test_secret_passes_through_unchanged_at_or_below_cap():
    at_cap = "a" * BCRYPT_MAX_BYTES
    assert _bcrypt_secret(at_cap) == at_cap.encode("utf-8")
    assert _bcrypt_secret("short") == b"short"


def test_over_cap_secret_is_folded_under_the_cap_without_nul_bytes():
    folded = _bcrypt_secret("a" * (BCRYPT_MAX_BYTES + 1))
    assert len(folded) <= BCRYPT_MAX_BYTES
    # A raw digest could contain NUL, which C bcrypt reads as end-of-string and
    # would truncate all over again; base64 output cannot.
    assert b"\x00" not in folded


def test_long_passwords_differing_only_after_byte_72_do_not_collide():
    # The exact defect this guards: with a raw bcrypt call both of these verify
    # against either hash, so the tail of a long password carries no security.
    prefix = "z" * BCRYPT_MAX_BYTES
    stored = hash_password(prefix + "-real-tail")
    assert verify_password(prefix + "-real-tail", stored) is True
    assert verify_password(prefix + "-attacker-tail", stored) is False


def test_full_max_length_multibyte_password_round_trips():
    # 128 CJK characters = 384 UTF-8 bytes; truncation could even split a character.
    password = "密" * MAX_LENGTH
    stored = hash_password(password)
    assert verify_password(password, stored) is True
    assert verify_password("密" * (MAX_LENGTH - 1), stored) is False


def test_pre_fold_bcrypt_hashes_still_verify():
    # An account created before the fold stored bcrypt(raw), which bcrypt itself
    # truncated at 72 bytes. Those users must not be locked out.
    password = "y" * 100
    legacy = bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt(rounds=4)
    ).decode("utf-8")
    assert verify_password(password, legacy) is True


def test_legacy_pbkdf2_hashes_still_verify():
    import hashlib

    salt = "deadbeef"
    digest = hashlib.pbkdf2_hmac(
        "sha256", b"legacy-pw-1", salt.encode("utf-8"), users_module.LEGACY_PBKDF2_ITERATIONS
    ).hex()
    stored = f"{salt}${digest}"
    assert verify_password("legacy-pw-1", stored) is True
    assert verify_password("legacy-pw-2", stored) is False


def test_malformed_hash_is_rejected_not_raised():
    assert verify_password("anything", "$2b$not-a-real-hash") is False
    assert verify_password("anything", "no-dollar-sign-at-all") is False

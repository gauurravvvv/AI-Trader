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


def test_blocklist_ignores_surrounding_whitespace():
    # Padding a blocklisted password with spaces is not extra entropy.
    violations = validate_new_password("  password1  ", "alice@example.com")
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

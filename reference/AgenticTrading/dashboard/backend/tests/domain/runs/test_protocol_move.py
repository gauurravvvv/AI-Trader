"""Phase 3B2 — run protocol move + characterization.

Verifies identity/re-export, the domain->api/scripts import boundary, and that
the protocol primitives behave exactly as before.
"""

import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from dashboard.backend.domain.runs import protocol as canon
from dashboard.backend.domain.runs.protocol import (
    DecisionIn,
    OrderIn,
    ProtocolError,
    error_body,
    order_to_action,
    resolve_order_quantity,
)

_REEXPORTED = [
    "PROTOCOL_VERSION", "VALID_SIDES", "VALID_QUANTITY_TYPES", "VALID_ORDER_TYPES",
    "ProtocolError", "error_body", "OrderIn", "DecisionIn",
    "resolve_order_quantity", "order_to_action",
]


def _order(**overrides):
    params = dict(symbol="AAPL", side="buy", quantity_type="shares", quantity=10)
    params.update(overrides)
    return OrderIn(**params)


# ---------------------------------------------------------------------------
# Canonical surface
# ---------------------------------------------------------------------------

def test_canonical_exports_present():
    for name in _REEXPORTED:
        assert hasattr(canon, name), name
    assert canon.ProtocolError.__module__ == "dashboard.backend.domain.runs.protocol"


def test_constants_unchanged():
    assert canon.PROTOCOL_VERSION == "1.0"
    assert canon.VALID_SIDES == {"buy", "sell"}
    assert canon.VALID_QUANTITY_TYPES == {"shares", "notional", "weight"}
    assert canon.VALID_ORDER_TYPES == {"market"}


# ---------------------------------------------------------------------------
# Import boundary
# ---------------------------------------------------------------------------

def test_domain_module_does_not_import_api_or_scripts():
    tree = ast.parse(Path(canon.__file__).read_text(encoding="utf-8"))
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            mods.add(node.module)
    for m in mods:
        assert not m.startswith("dashboard.backend.api"), m
        assert not m.startswith("dashboard.scripts"), m


# ---------------------------------------------------------------------------
# Error envelope
# ---------------------------------------------------------------------------

def test_protocol_error_to_body():
    err = ProtocolError("bad_thing", "It broke", status_code=409, details={"x": 1})
    assert err.code == "bad_thing"
    assert err.status_code == 409
    body = err.to_body()
    assert body == {
        "protocol_version": "1.0",
        "error": {"code": "bad_thing", "message": "It broke", "details": {"x": 1}},
    }


def test_error_body_without_details():
    body = error_body("c", "m")
    assert body == {"protocol_version": "1.0", "error": {"code": "c", "message": "m"}}


# ---------------------------------------------------------------------------
# Schema validation / defaults
# ---------------------------------------------------------------------------

def test_order_defaults():
    o = OrderIn(symbol="AAPL", side="buy", quantity=1)
    assert o.quantity_type == "shares"
    assert o.order_type == "market"


def test_order_rejects_negative_quantity():
    with pytest.raises(ValidationError):
        OrderIn(symbol="AAPL", side="buy", quantity=-1)


def test_decision_requires_idempotency_key():
    with pytest.raises(ValidationError):
        DecisionIn(idempotency_key="")


def test_decision_confidence_bounds():
    with pytest.raises(ValidationError):
        DecisionIn(idempotency_key="k", confidence=1.5)
    d = DecisionIn(idempotency_key="k", confidence=0.5)
    assert d.confidence == 0.5
    assert d.orders == []


# ---------------------------------------------------------------------------
# resolve_order_quantity
# ---------------------------------------------------------------------------

def test_resolve_shares():
    assert resolve_order_quantity(_order(quantity=10), price=100, equity=1000) == (10, None)


def test_resolve_notional():
    o = _order(quantity_type="notional", quantity=1000)
    assert resolve_order_quantity(o, price=100, equity=1000) == (10, None)


def test_resolve_weight():
    o = _order(quantity_type="weight", quantity=0.5)
    assert resolve_order_quantity(o, price=100, equity=1000) == (5, None)


def test_resolve_missing_price():
    o = _order(quantity_type="notional", quantity=1000)
    assert resolve_order_quantity(o, price=0, equity=1000) == (0, "missing_price")


def test_resolve_unsupported_quantity_type():
    o = _order(quantity_type="bogus", quantity=1)
    shares, reason = resolve_order_quantity(o, price=100, equity=1000)
    assert shares == 0
    assert reason == "unsupported_quantity_type:bogus"


def test_resolve_unsupported_order_type():
    o = _order(order_type="limit", quantity=1)
    shares, reason = resolve_order_quantity(o, price=100, equity=1000)
    assert shares == 0
    assert reason == "unsupported_order_type:limit"


# ---------------------------------------------------------------------------
# order_to_action
# ---------------------------------------------------------------------------

def test_order_to_action_mapping():
    o = _order(side="BUY")
    action = order_to_action(o, shares=5, confidence=0.9, rationale="a clear reason")
    assert action == {
        "action": "buy",
        "symbol": "AAPL",
        "confidence": 0.9,
        "reasoning": "a clear reason",
        "position_size": 5,
        "stop_loss_price": None,
        "take_profit_price": None,
    }


def test_order_to_action_cleans_short_rationale():
    action = order_to_action(_order(), shares=1, confidence=0.5, rationale="hi")
    assert action["reasoning"] == "external agent decision"


def test_order_to_action_truncates_long_rationale():
    action = order_to_action(_order(), shares=1, confidence=0.5, rationale="x" * 600)
    assert len(action["reasoning"]) == 500

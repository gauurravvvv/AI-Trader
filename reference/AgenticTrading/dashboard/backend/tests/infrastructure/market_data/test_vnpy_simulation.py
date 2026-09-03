"""Deterministic vn.py simulation provider contract.

These require the optional ``vnpy`` dependency (``requirements-vnpy.txt``); when
it is absent the whole module is skipped so the suite stays green on minimal
interpreters. ``vnpy_simulation`` imports ``vnpy`` at module scope, so without
the skip this raises during *collection* and aborts the entire pytest session.
The provider boundary's own always-on tests live in ``test_provider.py``.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys

import pandas as pd
import pytest

pytest.importorskip("vnpy")

from dashboard.backend.infrastructure.llm.validator import DJIA_30
from dashboard.backend.infrastructure.market_data.alpaca_bars import (
    MarketDataUnavailableError,
)
from dashboard.backend.infrastructure.market_data.provider import (
    VNPY_SIMULATION,
    create_market_data_provider,
)
from dashboard.backend.infrastructure.market_data.vnpy_simulation import (
    VnpySimulationProvider,
)


START = "2026-04-01"
END = "2026-04-23"


def frame_digest(frame: pd.DataFrame) -> str:
    payload = frame.to_csv(float_format="%.10f").encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def test_generates_normalized_hourly_frames_for_full_djia30():
    frames = VnpySimulationProvider().fetch_bars(DJIA_30, START, END)

    assert set(frames) == set(DJIA_30)
    assert all(len(frame) >= 50 for frame in frames.values())
    for frame in frames.values():
        assert list(frame.columns) == ["open", "high", "low", "close", "volume"]
        assert str(frame.index.tz) == "US/Eastern"
        assert frame.index.is_monotonic_increasing
        assert not frame.index.has_duplicates


def test_uses_weekdays_market_hours_and_exclusive_end():
    frame = VnpySimulationProvider().fetch_bars(["AAPL"], START, END)["AAPL"]
    local = frame.index.tz_convert("US/Eastern")

    assert all(timestamp.weekday() < 5 for timestamp in local)
    assert {(timestamp.hour, timestamp.minute) for timestamp in local} == {
        (10, 0),
        (11, 0),
        (12, 0),
        (13, 0),
        (14, 0),
        (15, 0),
        (16, 0),
    }
    assert local.min().date().isoformat() == START
    assert local.max().date().isoformat() < END


def test_same_input_is_exactly_deterministic():
    provider = VnpySimulationProvider()

    first = provider.fetch_bars(["AAPL", "MSFT"], START, END)
    second = provider.fetch_bars(["AAPL", "MSFT"], START, END)

    for symbol in first:
        pd.testing.assert_frame_equal(first[symbol], second[symbol], check_exact=True)


def test_output_is_stable_across_python_processes():
    code = (
        "import hashlib\n"
        "from dashboard.backend.infrastructure.market_data.vnpy_simulation "
        "import VnpySimulationProvider\n"
        f"frame = VnpySimulationProvider().fetch_bars(['AAPL'], '{START}', '{END}')['AAPL']\n"
        "print(hashlib.sha256(frame.to_csv(float_format='%.10f').encode()).hexdigest())\n"
    )
    results = [
        subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        for _ in range(2)
    ]

    assert results[0] == results[1]


def test_canonical_path_contains_decline_recovery_and_sideways_regimes():
    frame = VnpySimulationProvider().fetch_bars(["AAPL"], START, END)["AAPL"]
    returns = frame["close"].pct_change().dropna()

    assert returns.min() < -0.008
    assert returns.max() > 0.008
    assert returns.tail(10).abs().max() < 0.003


def test_weekend_only_window_fails_explicitly():
    with pytest.raises(MarketDataUnavailableError, match="trading timestamps"):
        VnpySimulationProvider().fetch_bars(["AAPL"], "2026-04-04", "2026-04-06")


def test_factory_creates_simulation_provider_when_enabled(monkeypatch):
    monkeypatch.setenv("ENABLE_VNPY_SIMULATION", "true")

    created = create_market_data_provider(VNPY_SIMULATION)

    assert isinstance(created, VnpySimulationProvider)


def test_factory_import_remains_lazy_when_simulation_is_not_selected():
    env = {**os.environ, "ENABLE_VNPY_SIMULATION": "false"}
    code = (
        "import sys\n"
        "from dashboard.backend.infrastructure.market_data import provider\n"
        "assert 'dashboard.backend.infrastructure.market_data.vnpy_simulation' "
        "not in sys.modules\n"
        "assert not any(name == 'vnpy' or name.startswith('vnpy.') "
        "for name in sys.modules)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr

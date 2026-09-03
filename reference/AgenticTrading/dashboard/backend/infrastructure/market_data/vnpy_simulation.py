"""Deterministic vn.py hourly bars for offline integration testing."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from hashlib import sha256
from zoneinfo import ZoneInfo

import pandas as pd
from vnpy.trader.constant import Exchange, Interval
from vnpy.trader.object import BarData

from .alpaca_bars import MarketDataUnavailableError
from .vnpy_adapter import bars_to_frame


MARKET_TIMEZONE = ZoneInfo("US/Eastern")
MARKET_HOURS = range(10, 17)


def _stable_unit(*parts: object) -> float:
    """Map canonical inputs to a stable float in [0, 1)."""
    payload = "|".join(str(part) for part in parts).encode("utf-8")
    value = int.from_bytes(sha256(payload).digest()[:8], "big")
    return value / 2**64


def _market_timestamps(start: date, end: date) -> list[datetime]:
    timestamps: list[datetime] = []
    current = start
    while current < end:
        if current.weekday() < 5:
            timestamps.extend(
                datetime(
                    current.year,
                    current.month,
                    current.day,
                    hour,
                    tzinfo=MARKET_TIMEZONE,
                )
                for hour in MARKET_HOURS
            )
        current += timedelta(days=1)
    return timestamps


def _hourly_return(symbol: str, timestamp: datetime, index: int) -> float:
    noise = (_stable_unit(symbol, timestamp.isoformat(), "return") - 0.5) * 0.0006
    if index < 24:
        return 0.0002 + noise
    if index < 50:
        return -0.012 + noise
    if index < 78:
        return 0.014 + noise
    return noise * 2


def _symbol_bars(
    symbol: str,
    timestamps: list[datetime],
    start: str,
    end: str,
) -> list[BarData]:
    base_price = 40 + _stable_unit(symbol, start, end, "base") * 360
    base_volume = 500_000 + int(_stable_unit(symbol, "volume") * 1_500_000)
    previous_close = base_price
    bars: list[BarData] = []

    for index, timestamp in enumerate(timestamps):
        open_price = round(previous_close, 6)
        close_price = round(
            max(0.01, open_price * (1 + _hourly_return(symbol, timestamp, index))),
            6,
        )
        spread = 0.0015 + _stable_unit(symbol, timestamp.isoformat(), "spread") * 0.001
        high_price = round(max(open_price, close_price) * (1 + spread), 6)
        low_price = round(min(open_price, close_price) * (1 - spread), 6)
        volume_factor = 0.8 + _stable_unit(symbol, timestamp.isoformat(), "volume") * 0.4
        volume = float(round(base_volume * volume_factor))

        bars.append(
            BarData(
                gateway_name="VNPY_SIM",
                symbol=symbol,
                exchange=Exchange.SMART,
                datetime=timestamp,
                interval=Interval.HOUR,
                open_price=open_price,
                high_price=high_price,
                low_price=low_price,
                close_price=close_price,
                volume=volume,
            )
        )
        previous_close = close_price

    return bars


class VnpySimulationProvider:
    """Generate deterministic US-equity bars using vn.py data objects."""

    def fetch_bars(
        self,
        symbols: list[str],
        start: str,
        end: str,
    ) -> dict[str, pd.DataFrame]:
        start_date = date.fromisoformat(start)
        end_date = date.fromisoformat(end)
        if end_date < start_date:
            raise ValueError("end must not be before start")

        timestamps = _market_timestamps(start_date, end_date)
        if not timestamps:
            raise MarketDataUnavailableError(
                f"No US-equity trading timestamps in {start}..{end}"
            )

        return {
            symbol: bars_to_frame(_symbol_bars(symbol, timestamps, start, end))
            for symbol in dict.fromkeys(symbols)
        }

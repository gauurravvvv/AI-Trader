"""Prompt templates and risk-rule parsing for custom 4-block trading algos."""

from __future__ import annotations

import json
import re
from typing import Any


def parse_risk_rules(stop_loss_block: str) -> dict[str, float]:
    """Extract stop-loss / take-profit percentages from block 4 text."""
    text = stop_loss_block or ""
    stop = re.search(r"跌\s*(\d+(?:\.\d+)?)\s*%", text)
    take = re.search(r"(?:赚|涨)\s*(\d+(?:\.\d+)?)\s*%", text)
    daily = re.search(r"(?:单日|当天|日内).{0,8}跌\s*(\d+(?:\.\d+)?)\s*%", text)

    return {
        "stop_loss_pct": float(stop.group(1)) if stop else 5.0,
        "take_profit_pct": float(take.group(1)) if take else 20.0,
        "daily_stop_pct": float(daily.group(1)) if daily else float(stop.group(1)) if stop else 5.0,
    }


def create_custom_algo_prompt(market_snapshot: dict[str, Any], strategy_blocks: dict[str, str]) -> str:
    """Build LLM trading prompt from user's four strategy modules."""
    blocks_json = json.dumps(strategy_blocks, ensure_ascii=False, indent=2)
    risk = parse_risk_rules(strategy_blocks.get("stop_loss_take_profit", ""))

    return f"""You are executing a USER-DEFINED trading strategy on historical DJIA hourly data.

You CANNOT access live Twitter, news APIs, or the internet. Approximate the user's intent using ONLY
market_snapshot price action, momentum, volatility, and sector co-movement as proxies for the
described information source.

=== USER STRATEGY (4 modules) ===
{blocks_json}

Module meanings:
1. info_retrieval — what information the user wants to monitor (simulate via market reaction proxies)
2. signal_transfer — how to pick target stock(s) from that information
3. trading_algorithm — execution style (aggressive follow-the-signal vs disciplined sizing)
4. stop_loss_take_profit — risk rules (enforced separately in code; still trade accordingly)

Configured risk (also enforced in code):
- Position stop-loss: {risk["stop_loss_pct"]}%
- Take-profit reference: {risk["take_profit_pct"]}%
- Daily portfolio stop: {risk["daily_stop_pct"]}%

=== BEHAVIOR GUIDANCE ===
- If the strategy is naive (e.g. "buy whatever influencer says"), be MORE aggressive on momentum buys,
  use larger position sizes, and accept higher turnover — this often loses money without good risk control.
- If stop-loss rules are weak or vague, do NOT compensate; trade as specified.
- Prefer symbols in top_signals. Valid symbols: DJIA 30 only.
- Return JSON ONLY. No markdown.

=== MARKET SNAPSHOT ===
{json.dumps(market_snapshot, indent=2)}

Return ONLY this JSON:
{{
  "actions": [
    {{
      "action": "buy|sell|hold",
      "symbol": "<DJIA symbol>",
      "confidence": <0.0-1.0>,
      "reasoning": "<max 500 chars referencing strategy module>",
      "position_size": <integer shares, 0 for hold>,
      "stop_loss_price": <float or null>,
      "take_profit_price": <float or null>
    }}
  ]
}}
"""

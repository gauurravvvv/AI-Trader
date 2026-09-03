"""LLM decision-response JSON repair helpers.

Extracted (Phase 2A) verbatim from ``fix_json_formatting`` in
``dashboard/scripts/backtest_hourly_agent.py``. Only pure JSON-repair logic lives
here — the Anthropic client, prompt construction, model invocation, and the full
``make_trading_decision_with_llm()`` workflow are intentionally NOT moved.

The set of accepted/repaired formats is unchanged from the original.
"""

import re


def fix_json_formatting(json_str: str) -> str:
    """
    Try to fix common JSON formatting issues from LLM responses.

    Fixes:
    - Missing commas between objects in arrays
    - Trailing commas
    - Extra closing brackets
    """
    # Fix 1: Add missing commas between objects in arrays (most common issue)
    # Pattern: } followed by newline(s) and whitespace and {
    # This handles: }
    #             {
    json_str = re.sub(r'(\})\s*\n\s*(\{)', r'\1,\n\2', json_str)

    # Fix 1b: Also handle } with no space then {
    json_str = re.sub(r'(\})(\{)', r'\1,\2', json_str)

    # Fix 2: Remove trailing commas before closing brackets
    # Pattern: , followed by optional whitespace and ] or }
    json_str = re.sub(r',(\s*[\]}])', r'\1', json_str)

    # Fix 3: Remove multiple closing brackets (sometimes LLM adds extra ones)
    # Pattern: ]]}  should be ]
    json_str = re.sub(r'\]\s*\}\s*\]', ']', json_str)

    # Fix 4: Fix }] at the end - should just be ]
    json_str = re.sub(r'\}\s*\]\s*$', ']', json_str)

    return json_str

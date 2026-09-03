"""H7 — the Discord bot must not forward a sentinel model id.

``discord`` is an undeclared optional dep, so importing ``discord_bot`` isn't
possible in the base test env. These checks read the source directly (no import)
so the wiring is locked even where discord is absent — the behavioral test lives
in tests/domain/chat/test_discord_bot.py under ``importorskip('discord')``.
"""

import re
from pathlib import Path

_DISCORD_BOT = (
    Path(__file__).resolve().parents[2] / "integrations" / "discord_bot.py"
)


def _source() -> str:
    return _DISCORD_BOT.read_text(encoding="utf-8")


def test_bot_uses_model_override_helper():
    src = _source()
    assert "from dashboard.backend.infrastructure.llm.token_cost import is_free_model" in src
    assert "def _model_override(" in src
    # Used at BOTH forwarding sites (/ask model= and /backtest payload["model"]).
    assert src.count("_model_override(") >= 3  # 1 definition + 2 call sites


def test_bot_no_longer_forwards_raw_sentinel_model():
    src = _source()
    # The old raw forwards that leaked the 'local-model' sentinel are gone.
    assert 'payload["model"] = selected["model_name"]' not in src
    assert "model = selected.get(\"model_name\") if selected else None" not in src


_REPO_ROOT = Path(__file__).resolve().parents[4]


def test_discord_dependency_is_declared():
    """MEDIUM #11 — discord_bot.py imports ``discord`` (discord.py 2.x), but the
    dep was undeclared, so the bot was unrunnable from any declared requirements
    file. Declare it in an optional ``requirements-discord.txt`` (mirroring
    ``requirements-sphinx.txt`` for docs) rather than core ``requirements.txt``,
    so web/API/backtest installs stay lean, and point contributors at it in
    CLAUDE.md.
    """
    req = _REPO_ROOT / "requirements-discord.txt"
    assert req.exists(), "requirements-discord.txt is missing"
    lines = [ln.strip() for ln in req.read_text(encoding="utf-8").splitlines()]
    # A real requirement line pinning discord.py (not merely a comment mention).
    assert any(re.match(r"^discord\.py\s*[<>=~!]", ln) for ln in lines), \
        "requirements-discord.txt must pin discord.py as a requirement"
    # Self-contained: pulls core deps so the bot is runnable from this file alone.
    assert "-r requirements.txt" in lines
    # Keep discord.py OUT of core requirements.txt (optional integration, not core).
    core = (_REPO_ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "discord.py" not in core
    # CLAUDE.md must point contributors at the optional file.
    claude_md = (_REPO_ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    assert "requirements-discord.txt" in claude_md


def test_bot_backtest_sends_agent_id_for_builtin_card():
    src = _source()
    assert 'payload["agent_id"] = selected["agent_id"]' in src
    assert 'selected.get("agent_type") or "builtin") == "builtin"' in src


def test_bot_agent_uses_owned_discord_agents_endpoint():
    """Discord /agent must list the linked website user's agents, not the
    public /agents/builtin catalog."""
    src = _source()
    assert "/api/v1/discord/agents" in src
    assert "fetch_owned_agents" in src
    assert "discord_not_linked" in src
    # Public catalog must not be the /agent source of truth anymore.
    assert "fetch_builtin_agents" not in src
    assert 'api_get("/api/v1/agents/builtin")' not in src


def test_bot_builds_dashboard_backtest_deep_link():
    src = _source()
    assert "def dashboard_backtest_url(" in src
    assert '"view": "backtest"' in src
    assert "agent_id" in src and "run_id" in src
    assert "Dashboard:" in src
    assert "agentic-trading-lab.vercel.app" in src
    assert "onrender.com" in src  # prod API detection / never deep-link that host
    assert "dashboard_backtest_url(agent_id=agent_id, run_id=run_id)" in src


def test_bot_decouples_backtest_wait_from_interaction():
    """Discord must ACK immediately and deliver results via a background job.

    Long LLM backtests exceed Discord's ~15m interaction token; polling inside
    the slash handler used to drop the chart. Results post in-channel instead.
    """
    src = _source()
    assert "schedule_backtest_watch" in src
    assert "watch_and_deliver_backtest" in src
    assert "get_job_store().create_job" in src
    assert "_post_channel_result" in src
    assert "resume_open_backtest_jobs" in src
    # Old blocking poll budget must not live inside execute_backtest anymore.
    assert "max_polls = 130" not in src
    assert "I'll post the results" in src


def test_bot_sends_per_user_id_on_strategy_post():
    """MEDIUM #4 — the bot must send a per-Discord-user X-Browser-Id when creating
    a strategy, else all Discord users share the bot process's single (IP) bucket
    on the server's write rate limiter."""
    src = _source()
    assert '"X-Browser-Id": f"discord:{discord_user_id}"' in src
    assert "X-Discord-Bot-Secret" in src
    assert "DISCORD_BOT_API_SECRET" in src

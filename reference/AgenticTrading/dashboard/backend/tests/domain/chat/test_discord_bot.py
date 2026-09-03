"""Focused tests for Discord integration import-safety (Phase 3D3B).

These require the optional ``discord`` dependency; when it is absent the whole
module is skipped so the suite stays green on minimal interpreters. No real
Discord connection or network call is made.
"""

import asyncio
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

discord = pytest.importorskip("discord")

import dashboard.backend.integrations.discord_bot as bot_mod

_BACKEND = Path(__file__).resolve().parents[3]
_REPO_ROOT = _BACKEND.parents[1]


def test_default_agent_id_unchanged():
    assert bot_mod.DEFAULT_AGENT_ID == "default"


def test_command_names_and_registration_unchanged():
    names = {cmd.name for cmd in bot_mod.bot.tree.get_commands()}
    assert {"ask", "reset", "agent"} <= names


def test_bot_prefix_and_message_content_intent():
    assert bot_mod.bot.command_prefix == "!"
    expected = discord.Intents.default()
    expected.message_content = True
    assert bot_mod.bot.intents.value == expected.value


def test_should_handle_free_chat():
    assert bot_mod.should_handle_free_chat(
        author_is_bot=False,
        content="hello",
        is_dm=True,
        channel_id=1,
        mentions_bot=False,
        is_reply_to_bot=False,
    )
    assert not bot_mod.should_handle_free_chat(
        author_is_bot=True,
        content="hello",
        is_dm=True,
        channel_id=1,
        mentions_bot=False,
        is_reply_to_bot=False,
    )
    assert not bot_mod.should_handle_free_chat(
        author_is_bot=False,
        content="",
        is_dm=False,
        channel_id=1,
        mentions_bot=False,
        is_reply_to_bot=False,
    )
    assert bot_mod.should_handle_free_chat(
        author_is_bot=False,
        content="",
        is_dm=False,
        channel_id=1,
        mentions_bot=True,
        is_reply_to_bot=False,
    )
    assert bot_mod.should_handle_free_chat(
        author_is_bot=False,
        content="hi",
        is_dm=False,
        channel_id=99,
        mentions_bot=True,
        is_reply_to_bot=False,
    )


def test_extract_chat_prompt_strips_mention():
    assert bot_mod.extract_chat_prompt(
        "<@123456789> what is momentum?",
        bot_user_id=123456789,
    ) == "what is momentum?"


def test_model_override_maps_sentinel_to_none():
    # H7: a selected agent's default 'local-model' sentinel means "no override".
    assert bot_mod._model_override("local-model") is None
    assert bot_mod._model_override("rule-based") is None
    assert bot_mod._model_override(None) is None
    # A real model id passes through unchanged.
    assert bot_mod._model_override("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001"


def test_consumes_canonical_chat_service():
    # The bot must call the canonical chat boundary, not Anthropic directly.
    from dashboard.backend.domain.chat.service import (
        chat_with_agent,
        reset_agent_conversation,
    )

    assert bot_mod.chat_with_agent is chat_with_agent
    assert bot_mod.reset_agent_conversation is reset_agent_conversation


def test_split_discord_message_short_returns_single_chunk():
    assert bot_mod.split_discord_message("hello", limit=1800) == ["hello"]


def test_split_discord_message_splits_long_text():
    text = "\n".join(f"line {i}" for i in range(500))
    chunks = bot_mod.split_discord_message(text, limit=100)
    assert len(chunks) > 1
    assert all(len(chunk) <= 100 for chunk in chunks)


def test_fetch_owned_agents_maps_not_linked_code(monkeypatch):
    """A 404 carrying ``code=discord_not_linked`` is the unlinked case."""
    monkeypatch.setattr(
        bot_mod,
        "_http_get_status",
        lambda *a, **k: (404, {"detail": {"code": "discord_not_linked"}}),
    )
    agents, err = asyncio.run(bot_mod.fetch_owned_agents("123"))
    assert agents == []
    assert err == "discord_not_linked"


def test_fetch_owned_agents_other_404_is_fetch_failed(monkeypatch):
    """A bare 404 (bad ATL_API_BASE / route rename) must NOT read as 'unlinked'."""
    monkeypatch.setattr(
        bot_mod,
        "_http_get_status",
        lambda *a, **k: (404, {"detail": "Not Found"}),
    )
    agents, err = asyncio.run(bot_mod.fetch_owned_agents("123"))
    assert agents == []
    assert err == "fetch_failed"


def test_format_backtest_summary_includes_dashboard_link():
    summary, run_id = bot_mod.format_backtest_summary(
        {
            "run_id": "agent_test",
            "start_date": "2026-05-01",
            "end_date": "2026-05-07",
            "llm_model": "claude-haiku",
            "total_return": 0.12,
            "sharpe_ratio": 1.5,
            "max_drawdown": -0.05,
            "num_trades": 3,
            "final_equity": 112000,
        },
        label="e23badad",
        agent_id="ag1",
        agent_name="Berkshire",
    )
    assert run_id == "agent_test"
    assert "Backtest complete" in summary
    assert "e23badad" in summary
    assert "Berkshire" in summary
    assert "view=backtest" in summary
    assert "agent_id=ag1" in summary


def test_discord_bot_imports_without_secrets():
    code = textwrap.dedent(
        """
        import os
        for var in (
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "DISCORD_BOT_TOKEN",
            "DISCORD_GUILD_ID",
        ):
            os.environ.pop(var, None)

        import dashboard.backend.domain.chat.service
        import dashboard.backend.integrations.discord_bot as bot_mod
        # Importing must not construct the Anthropic client nor connect Discord.
        assert dashboard.backend.domain.chat.service._claude_client is None
        assert not bot_mod.bot.is_ready()
        print("import-safe")
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(_REPO_ROOT),
    )
    assert result.returncode == 0, result.stderr
    assert "import-safe" in result.stdout

"""PR-2 of the FinSearch score-field disambiguation: the transitional v1 `score`
fallback is gone, so a v1-only payload is now a KeyError rather than a silent
kindness. This module is only about which key `_project_entry` READS.

Why there is no fallback to be tolerant of, and why `_project_entry` still
deliberately EMITS the internal key `score`: see the "two vocabularies" note in
docs/integrations/finsearch-news-sentiment.md.
"""
import pytest

from dashboard.backend.integrations.news_sentiment import _project_entry

BASE = {"sentiment": "bullish", "rationale": "r", "headline": "h",
        "source": "Reuters", "url": "https://example.com/a",
        "published": 1783330000.0, "guid": "g1", "n_articles": 2}


def test_project_entry_reads_sentiment_score_v2():
    entry = _project_entry({**BASE, "sentiment_score": 0.5},
                           reference_ts=1783333600.0)
    assert entry["score"] == 0.5


def test_project_entry_rejects_v1_score_only():
    """The deleted fallback accepted this silently. The wire cannot produce it
    any more, so staying quiet here would mean a real producer break renders as
    a normal-looking sentiment number instead of a fault."""
    with pytest.raises(KeyError):
        _project_entry({**BASE, "score": -0.3}, reference_ts=1783333600.0)


def test_project_entry_raises_when_sentiment_score_absent():
    """Fail loud like every other required field: score=None would flow
    silently into the panel and into every backtest step."""
    with pytest.raises(KeyError):
        _project_entry(dict(BASE), reference_ts=1783333600.0)

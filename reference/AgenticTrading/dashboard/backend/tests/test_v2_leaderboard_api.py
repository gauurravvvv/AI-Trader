

from dashboard.backend.api.v2.leaderboard import build_leaderboard


def test_build_leaderboard_ranks_v2_runs_by_return():
    runs = [
        {"run_id": "run_a", "agent_name": "A", "total_return": 0.05,
         "sharpe_ratio": 1.0, "max_drawdown": -0.02, "final_equity": 105000,
         "num_trades": 4, "llm_model": "m"},
        {"run_id": "run_b", "agent_name": "B", "total_return": 0.12,
         "sharpe_ratio": 1.5, "max_drawdown": -0.03, "final_equity": 112000,
         "num_trades": 7, "llm_model": "m"},
        {"run_id": "ext_legacy", "agent_name": "C", "total_return": 0.20},  # not v2
    ]
    board = build_leaderboard(runs)
    assert [e["run_id"] for e in board] == ["run_b", "run_a"]  # v2 only, ranked desc
    assert board[0]["rank"] == 1

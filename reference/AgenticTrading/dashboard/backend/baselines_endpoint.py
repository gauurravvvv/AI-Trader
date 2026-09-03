"""
Baselines endpoint logic - fetch from backtest runs or database.
Uses same data source as backtesting for consistency.
"""

from dashboard.backend.database import db
from typing import Dict


def get_baselines_from_db() -> Dict:
    """
    Fetch DJIA and Buy-and-Hold baselines for paper trading.
    Uses paper_baseline mode (calculated from paper account date range).
    
    Returns:
        Dict with 'djia' and 'buy_and_hold' equity curves
    """
    try:
        baselines = {}
        
        # Get paper trading baselines (calculated for account's date range)
        paper_baseline_runs = db.get_runs_by_mode("paper_baseline")
        
        if paper_baseline_runs:
            for run in paper_baseline_runs:
                agent_name = run.get("agent_name", "").lower()
                
                # Look for DJIA Index
                if "djia" in agent_name and "djia" not in baselines:
                    curve = db.get_equity_curve(run['run_id'])
                    if curve:
                        baselines["djia"] = curve
                
                # Look for Buy-and-Hold
                if "buy" in agent_name and "hold" in agent_name and "buy_and_hold" not in baselines:
                    curve = db.get_equity_curve(run['run_id'])
                    if curve:
                        baselines["buy_and_hold"] = curve
        
        if baselines:
            return {
                "success": True,
                "baselines": baselines,
                "note": "Paper trading baselines (calculated from account date range)"
            }
        else:
            return {
                "success": False,
                "error": "Paper baselines not yet created (creating on startup)",
                "baselines": {},
                "status": "initializing"
            }
    
    except Exception as e:
        print(f"Paper baselines fetch failed: {e!r}")
        return {
            "success": False,
            "error": "Failed to fetch baselines",
            "baselines": {}
        }

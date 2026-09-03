"""Paper-trading session tracking (canonical location, Phase 3C5B).

Moved verbatim from ``dashboard/backend/paper_trading.py`` (original module
removed in Phase 4A). Public symbols, signatures, defaults, stored
fields, timestamps, returned schemas, and exceptions are unchanged; only the
module location moved. This module owns session-tracking workflow only; the
Alpaca provider adapter lives in
``dashboard.backend.infrastructure.brokers.alpaca_paper``.
"""

from datetime import datetime
from typing import Dict, Optional


class PaperTradingSession:
    """Track a paper trading session with equity history."""
    
    def __init__(self, run_id: str, agent_name: str):
        self.run_id = run_id
        self.agent_name = agent_name
        self.start_time = datetime.now()
        self.equity_history = []
        self.trades_log = []
        self.last_equity = None
        self.initial_equity = None
    
    def add_equity_snapshot(self, equity: float, cash: float, 
                          positions_value: float, daily_return: Optional[float] = None):
        """Record an equity snapshot."""
        timestamp = datetime.now().isoformat()
        
        snapshot = {
            "timestamp": timestamp,
            "equity": equity,
            "cash": cash,
            "positions_value": positions_value,
            "daily_return": daily_return
        }
        
        self.equity_history.append(snapshot)
        self.last_equity = equity
        
        if self.initial_equity is None:
            self.initial_equity = equity
    
    def add_trade(self, symbol: str, qty: float, side: str, 
                  price: float, reason: str = ""):
        """Log a trade."""
        timestamp = datetime.now().isoformat()
        
        trade = {
            "timestamp": timestamp,
            "symbol": symbol,
            "qty": qty,
            "side": side,
            "price": price,
            "value": qty * price,
            "reason": reason
        }
        
        self.trades_log.append(trade)
    
    def get_metrics(self) -> Dict:
        """Calculate session metrics."""
        if not self.equity_history or self.initial_equity is None:
            return {}
        
        final_equity = self.last_equity or self.initial_equity
        total_return = ((final_equity - self.initial_equity) / self.initial_equity) * 100
        
        # Calculate simple stats
        equities = [s["equity"] for s in self.equity_history]
        max_equity = max(equities) if equities else self.initial_equity
        min_equity = min(equities) if equities else self.initial_equity
        max_drawdown = ((min_equity - max_equity) / max_equity) * 100 if max_equity > 0 else 0
        
        return {
            "total_return": round(total_return, 2),
            "max_drawdown": round(max_drawdown, 2),
            "final_equity": round(final_equity, 2),
            "num_trades": len(self.trades_log)
        }


def create_paper_trading_session(agent_name: str) -> str:
    """
    Create a new paper trading session and return run_id.
    
    Returns:
        run_id: Unique identifier for this session
    """
    import uuid
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_id = f"{agent_name}_{timestamp}_{uuid.uuid4().hex[:8]}"
    return run_id

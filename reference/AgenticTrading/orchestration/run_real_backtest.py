#!/usr/bin/env python3
"""
Real LLM Agent Backtest - Runs actual Claude/GPT-4/DeepSeek models
Compares agent performance against baselines (buy-and-hold, S&P 500, DJIA)
"""

import os
import json
import sqlite3
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path
import anthropic

# Initialize clients
CLAUDE_MODEL = "claude-3-5-sonnet-20241022"

def get_real_market_data(symbol, start_date, end_date):
    """Fetch real market data from Yahoo Finance."""
    try:
        data = yf.download(symbol, start=start_date, end=end_date, progress=False)
        if data is None or data.empty:
            print(f"⚠️ No data for {symbol}")
            return None
        
        # Handle MultiIndex columns from yfinance
        if isinstance(data.columns, pd.MultiIndex):
            data.columns = data.columns.get_level_values(0)  # Flatten to single level
        
        # Reset index to have integer index for iloc access
        data = data.reset_index(drop=True)
        
        # Ensure we have the required columns
        required_cols = ['Close', 'High', 'Low', 'Open']
        for col in required_cols:
            if col not in data.columns:
                print(f"⚠️ Missing {col} column for {symbol}")
                return None
        
        return data
    except Exception as e:
        print(f"❌ Error fetching {symbol}: {e}")
        import traceback
        traceback.print_exc()
        return None

def init_database():
    """Initialize SQLite database."""
    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(exist_ok=True)
    db_path = data_dir / "backtest.db"
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        mode TEXT NOT NULL,
        symbol TEXT,
        initial_equity REAL,
        final_equity REAL,
        total_return REAL,
        annual_return REAL,
        sharpe_ratio REAL,
        sortino_ratio REAL,
        max_drawdown REAL,
        win_rate REAL,
        total_trades INTEGER,
        avg_win REAL,
        avg_loss REAL,
        profit_factor REAL,
        calmar_ratio REAL,
        recovery_factor REAL,
        ulcer_index REAL,
        created_at TIMESTAMP
    )
    """)
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS equity_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        equity REAL,
        cash REAL,
        positions_value REAL,
        daily_return REAL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
    )
    """)
    
    conn.commit()
    conn.close()
    return db_path

def get_agent_signal(agent_name, symbol, price_history, market_context):
    """
    Get trading signal from Claude LLM.
    Returns: BUY, SELL, or HOLD
    """
    try:
        # Extract price data as simple list
        close_prices = price_history['Close'].tail(20).tolist() if len(price_history) > 0 else []
        current_price = float(price_history['Close'].iloc[-1]) if len(price_history) > 0 else 0
        ma50 = float(price_history['Close'].rolling(50).mean().iloc[-1]) if len(price_history) >= 50 else current_price
        rsi = calculate_rsi(price_history['Close']) if len(price_history) > 14 else 50
        volatility = float(price_history['Close'].pct_change().std() * 100) if len(price_history) > 1 else 0
        
        prompt = f"""You are a {agent_name} trading agent analyzing {symbol}.

Recent prices (last 20 days): {close_prices}

Market context:
- Current price: ${current_price:.2f}
- 50-day MA: ${ma50:.2f}
- RSI (14): {rsi:.1f}
- 20-day volatility: {volatility:.2f}%

Respond with ONLY: BUY, SELL, or HOLD
"""
        
        client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
        message = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=5,
            messages=[{"role": "user", "content": prompt}]
        )
        
        signal = message.content[0].text.strip().upper()
        
        if signal in ["BUY", "SELL", "HOLD"]:
            return signal
        else:
            return "HOLD"  # Default to hold if unclear
            
    except Exception as e:
        print(f"  ⚠️ Agent signal error: {e}")
        return "HOLD"

def calculate_rsi(prices, period=14):
    """Calculate RSI indicator."""
    deltas = prices.diff()
    seed = deltas[:period+1]
    up = seed[seed >= 0].sum() / period
    down = -seed[seed < 0].sum() / period
    rs = up / down if down != 0 else 0
    rsi = 100 - (100 / (1 + rs))
    return rsi

def calculate_metrics(equity_curve, trades, daily_returns, drawdowns, initial_equity):
    """Calculate comprehensive trading metrics."""
    final_equity = equity_curve[-1]['equity']
    total_return = (final_equity - initial_equity) / initial_equity
    annual_return = (final_equity / initial_equity) ** (252 / len(equity_curve)) - 1 if len(equity_curve) > 0 else 0
    
    # Sharpe Ratio
    daily_return_array = [e['daily_return'] for e in equity_curve]
    mean_return = sum(daily_return_array) / len(daily_return_array) if daily_return_array else 0
    variance = sum([(r - mean_return)**2 for r in daily_return_array]) / len(daily_return_array) if daily_return_array else 0
    std_dev = variance ** 0.5 if variance > 0 else 0.001
    sharpe = (mean_return / std_dev * (252 ** 0.5)) if std_dev > 0 else 0
    
    # Sortino Ratio
    negative_returns = [r for r in daily_return_array if r < 0]
    downside_std = (sum([r**2 for r in negative_returns]) / len(negative_returns)) ** 0.5 if negative_returns else 0
    sortino = (annual_return / (downside_std * (252 ** 0.5))) if downside_std > 0 else 0
    
    # Max Drawdown
    max_dd = max(drawdowns) if drawdowns else 0
    
    # Trade Stats
    winning_trades = [t for t in trades if t.get('pnl', 0) > 0]
    losing_trades = [t for t in trades if t.get('pnl', 0) < 0]
    win_rate = len(winning_trades) / len(trades) if trades else 0
    
    avg_win = sum([t.get('pnl', 0) for t in winning_trades]) / len(winning_trades) if winning_trades else 0
    avg_loss = sum([t.get('pnl', 0) for t in losing_trades]) / len(losing_trades) if losing_trades else 0
    
    profit_sum = sum([t.get('pnl', 0) for t in winning_trades]) if winning_trades else 0
    loss_sum = abs(sum([t.get('pnl', 0) for t in losing_trades])) if losing_trades else 0
    profit_factor = profit_sum / loss_sum if loss_sum > 0 else float('inf')
    
    calmar = annual_return / max_dd if max_dd > 0 else 0
    total_profit = sum([t.get('pnl', 0) for t in trades if t.get('pnl', 0) > 0])
    recovery_factor = total_profit / max_dd if max_dd > 0 else 0
    ulcer_index = (sum([dd**2 for dd in drawdowns]) / len(drawdowns)) ** 0.5 if drawdowns else 0
    
    return {
        'total_return': total_return,
        'annual_return': annual_return,
        'sharpe_ratio': sharpe,
        'sortino_ratio': sortino,
        'max_drawdown': max_dd,
        'win_rate': win_rate,
        'total_trades': len(trades),
        'avg_win': avg_win,
        'avg_loss': avg_loss,
        'profit_factor': profit_factor,
        'calmar_ratio': calmar,
        'recovery_factor': recovery_factor,
        'ulcer_index': ulcer_index,
        'final_equity': final_equity
    }

def run_agent_backtest(agent_name, symbol, price_data, initial_equity=100000):
    """Run backtest for a single agent on a symbol."""
    equity_curve = []
    cash = initial_equity
    position = 0
    entry_price = 0
    trades = []
    daily_returns = []
    drawdowns = []
    
    print(f"\n  Running {agent_name} on {symbol}...")
    
    for i in range(50, len(price_data)):  # Start after 50-day warmup
        current_price = float(price_data['Close'].iloc[i])
        
        # Get agent signal
        signal = get_agent_signal(agent_name, symbol, price_data.iloc[max(0, i-50):i], {})
        
        # Execute trades based on signal
        if signal == "BUY" and position == 0:
            entry_price = current_price
            position = 1
            trades.append({'entry_price': entry_price, 'day': i, 'type': 'BUY', 'signal': signal})
        
        elif signal == "SELL" and position == 1:
            pnl_pct = (current_price - entry_price) / entry_price
            cash += position * current_price
            position = 0
            trades.append({'exit_price': current_price, 'day': i, 'pnl': pnl_pct * 100, 'type': 'SELL', 'signal': signal})
        
        # Calculate equity
        positions_value = (position * current_price) if position else 0
        total_equity = cash + positions_value
        daily_return = (total_equity - initial_equity) / initial_equity if i == 50 else (total_equity - equity_curve[-1]['equity']) / equity_curve[-1]['equity']
        
        equity_curve.append({
            'day': i,
            'price': current_price,
            'equity': total_equity,
            'cash': cash,
            'positions_value': positions_value,
            'daily_return': daily_return
        })
        
        daily_returns.append(daily_return)
        
        # Track drawdown
        peak = max([e['equity'] for e in equity_curve])
        dd = (peak - total_equity) / float(peak) if peak > 0 else 0
        drawdowns.append(dd)
    
    metrics = calculate_metrics(equity_curve, trades, daily_returns, drawdowns, initial_equity)
    return equity_curve, trades, metrics

def run_baseline_backtest(baseline_name, symbol, price_data, initial_equity=100000):
    """Run baseline strategies (buy-and-hold, S&P 500, DJIA)."""
    equity_curve = []
    daily_returns = []
    drawdowns = []
    
    if baseline_name == "buy-and-hold":
        # Buy on first day, hold
        entry_price = float(price_data['Close'].iloc[50])
        shares = initial_equity / entry_price
        
        for i in range(50, len(price_data)):
            current_price = float(price_data['Close'].iloc[i])
            total_equity = shares * current_price
            daily_return = (total_equity - initial_equity) / initial_equity if i == 50 else (total_equity - equity_curve[-1]['equity']) / equity_curve[-1]['equity']
            
            equity_curve.append({'equity': total_equity, 'daily_return': daily_return, 'day': i})
            daily_returns.append(daily_return)
            
            peak = max([e['equity'] for e in equity_curve])
            dd = (peak - total_equity) / float(peak) if peak > 0 else 0
            drawdowns.append(dd)
    
    trades = [{'type': 'BUY', 'price': float(price_data['Close'].iloc[50])}]
    metrics = calculate_metrics(equity_curve, trades, daily_returns, drawdowns, initial_equity)
    return equity_curve, trades, metrics

def save_results(run_id, agent_name, symbol, initial_equity, metrics, equity_curve, db_path):
    """Save results to database."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
    INSERT OR REPLACE INTO runs (run_id, agent_name, mode, symbol, initial_equity, final_equity,
                      total_return, annual_return, sharpe_ratio, sortino_ratio, max_drawdown,
                      win_rate, total_trades, avg_win, avg_loss, profit_factor, calmar_ratio,
                      recovery_factor, ulcer_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        run_id, agent_name, 'backtest', symbol, initial_equity,
        metrics['final_equity'],
        metrics['total_return'],
        metrics['annual_return'],
        metrics['sharpe_ratio'],
        metrics['sortino_ratio'],
        metrics['max_drawdown'],
        metrics['win_rate'],
        metrics['total_trades'],
        metrics['avg_win'],
        metrics['avg_loss'],
        metrics['profit_factor'],
        metrics['calmar_ratio'],
        metrics['recovery_factor'],
        metrics['ulcer_index'],
        datetime.now()
    ))
    
    for bar in equity_curve:
        cursor.execute("""
        INSERT INTO equity_data (run_id, timestamp, equity, cash, positions_value, daily_return)
        VALUES (?, ?, ?, ?, ?, ?)
        """, (
            run_id,
            datetime.now() - timedelta(days=len(equity_curve) - bar['day'] if 'day' in bar else len(equity_curve)),
            bar['equity'],
            bar.get('cash', 0),
            bar.get('positions_value', 0),
            bar['daily_return']
        ))
    
    conn.commit()
    conn.close()

def main():
    """Run full backtest suite with real agents and baselines."""
    print("🚀 Starting Real LLM Agent Backtest")
    print(f"📅 Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S EDT')}")
    print("=" * 80)
    
    db_path = init_database()
    
    # Configuration
    start_date = "2024-06-01"
    end_date = "2024-12-31"
    agents = ['Claude']  # Start with Claude only (faster)
    symbols = ['AAPL', 'MSFT']
    baselines = ['buy-and-hold']
    
    results_summary = []
    
    # Fetch market data
    print(f"\n📊 Fetching market data ({start_date} to {end_date})...")
    market_data = {}
    for symbol in symbols:
        data = get_real_market_data(symbol, start_date, end_date)
        if data is not None:
            market_data[symbol] = data
            print(f"  ✅ {symbol}: {len(data)} days")
    
    if not market_data:
        print("❌ No market data fetched. Exiting.")
        return
    
    # Run agent backtests
    print(f"\n🤖 Running agent backtests...")
    for agent in agents:
        print(f"\n{agent}:")
        for symbol in symbols:
            if symbol not in market_data:
                continue
            
            equity_curve, trades, metrics = run_agent_backtest(
                agent, symbol, market_data[symbol], initial_equity=100000
            )
            
            run_id = f"{agent}_{symbol}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            save_results(run_id, agent, symbol, 100000, metrics, equity_curve, db_path)
            
            results_summary.append({
                'name': f"{agent}",
                'symbol': symbol,
                'type': 'Agent',
                'return': metrics['total_return'],
                'sharpe': metrics['sharpe_ratio'],
                'sortino': metrics['sortino_ratio'],
                'max_dd': metrics['max_drawdown'],
                'calmar': metrics['calmar_ratio'],
                'win_rate': metrics['win_rate'],
                'trades': metrics['total_trades'],
                'profit_factor': metrics['profit_factor']
            })
            
            print(f"  ✅ {symbol}: Return {metrics['total_return']*100:+.2f}% | Sharpe {metrics['sharpe_ratio']:.2f}")
    
    # Run baseline backtests
    print(f"\n📈 Running baseline backtests...")
    for baseline in baselines:
        print(f"\n{baseline}:")
        for symbol in symbols:
            if symbol not in market_data:
                continue
            
            equity_curve, trades, metrics = run_baseline_backtest(
                baseline, symbol, market_data[symbol], initial_equity=100000
            )
            
            run_id = f"{baseline}_{symbol}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            save_results(run_id, baseline, symbol, 100000, metrics, equity_curve, db_path)
            
            results_summary.append({
                'name': baseline,
                'symbol': symbol,
                'type': 'Baseline',
                'return': metrics['total_return'],
                'sharpe': metrics['sharpe_ratio'],
                'sortino': metrics['sortino_ratio'],
                'max_dd': metrics['max_drawdown'],
                'calmar': metrics['calmar_ratio'],
                'win_rate': metrics['win_rate'],
                'trades': metrics['total_trades'],
                'profit_factor': metrics['profit_factor']
            })
            
            print(f"  ✅ {symbol}: Return {metrics['total_return']*100:+.2f}% | Sharpe {metrics['sharpe_ratio']:.2f}")
    
    # Print leaderboard
    print("\n" + "=" * 120)
    print("📊 LEADERBOARD - Agents vs Baselines")
    print("=" * 120)
    
    if results_summary:
        # Sort by return descending
        results_summary.sort(key=lambda x: x['return'], reverse=True)
        
        print(f"{'Rank':<5} {'Agent/Baseline':<20} {'Symbol':<8} {'Type':<10} {'Return':<10} {'Sharpe':<8} {'Sortino':<8} {'Max DD':<10} {'Calmar':<8} {'Win Rate':<10} {'Trades':<8} {'PF':<8}")
        print("-" * 140)
        
        for idx, result in enumerate(results_summary, 1):
            print(f"{idx:<5} {result['name']:<20} {result['symbol']:<8} {result['type']:<10} "
                  f"{result['return']*100:+7.2f}% {result['sharpe']:>7.2f} {result['sortino']:>7.2f} "
                  f"{result['max_dd']*100:>8.2f}% {result['calmar']:>7.2f} {result['win_rate']*100:>8.1f}% "
                  f"{result['trades']:>7d} {result['profit_factor']:>7.2f}")
    
    print(f"\n✅ Backtest complete! Results saved to {db_path}")

if __name__ == '__main__':
    main()

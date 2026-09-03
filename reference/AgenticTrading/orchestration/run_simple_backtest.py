#!/usr/bin/env python3
"""
Simple backtest runner with comprehensive metrics.
Generates synthetic market data and runs backtest simulation.
"""

import json
import sqlite3
from datetime import datetime, timedelta
import random
import sys
from pathlib import Path

# Create data directory
data_dir = Path(__file__).parent / "data"
data_dir.mkdir(exist_ok=True)
db_path = data_dir / "backtest.db"

def init_database():
    """Initialize SQLite database schema."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create runs table
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
    
    # Create equity_data table
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

def generate_market_data(symbol="AAPL", days=252):
    """Generate synthetic market data."""
    data = []
    base_price = 150
    current_price = base_price
    
    for i in range(days):
        # Simulate price movement with some volatility
        daily_return = random.gauss(0.0005, 0.015)  # Mean 0.05%, std 1.5%
        current_price *= (1 + daily_return)
        
        data.append({
            'price': current_price,
            'return': daily_return,
            'day': i
        })
    
    return data

def run_trading_strategy(market_data, initial_equity=100000):
    """Simple momentum-based trading strategy."""
    equity_curve = []
    cash = initial_equity
    position = 0
    entry_price = 0
    trades = []
    daily_returns = []
    drawdowns = []
    
    for i, bar in enumerate(market_data):
        price = bar['price']
        
        # Simple momentum strategy
        if i > 20:
            # Calculate 20-day momentum
            recent_prices = [d['price'] for d in market_data[max(0, i-20):i]]
            momentum = (price - recent_prices[0]) / recent_prices[0]
            
            # Buy signal
            if momentum > 0.02 and position == 0:
                entry_price = price
                position = 1
                trades.append({'entry_price': price, 'day': i, 'type': 'BUY'})
            
            # Sell signal (profit taking at 3% or stop loss at -2%)
            elif position == 1:
                pnl_pct = (price - entry_price) / entry_price
                if pnl_pct > 0.03 or pnl_pct < -0.02:
                    cash = (cash / entry_price + 1) * price
                    position = 0
                    trades.append({'exit_price': price, 'day': i, 'pnl': pnl_pct * 100, 'type': 'SELL'})
        
        # Update equity
        positions_value = (position * price) if position else 0
        total_equity = cash + positions_value
        daily_return = (total_equity - initial_equity) / initial_equity if i == 0 else (total_equity - equity_curve[-1]['equity']) / equity_curve[-1]['equity']
        
        equity_curve.append({
            'day': i,
            'price': price,
            'equity': total_equity,
            'cash': cash,
            'positions_value': positions_value,
            'daily_return': daily_return
        })
        
        daily_returns.append(daily_return)
        
        # Track drawdown
        peak = max([e['equity'] for e in equity_curve])
        dd = (peak - total_equity) / peak if peak > 0 else 0
        drawdowns.append(dd)
    
    return equity_curve, trades, daily_returns, drawdowns

def calculate_metrics(equity_curve, trades, daily_returns, drawdowns, initial_equity):
    """Calculate comprehensive trading metrics."""
    final_equity = equity_curve[-1]['equity']
    total_return = (final_equity - initial_equity) / initial_equity
    annual_return = (final_equity / initial_equity) ** (252 / len(equity_curve)) - 1
    
    # Sharpe Ratio (assuming 0% risk-free rate)
    daily_return_array = [e['daily_return'] for e in equity_curve]
    sharpe = (sum(daily_return_array) / len(daily_return_array) / (max(0.001, sum([(r - sum(daily_return_array)/len(daily_return_array))**2 for r in daily_return_array]) / len(daily_return_array)) ** 0.5)) * (252 ** 0.5) if len(daily_return_array) > 0 else 0
    
    # Sortino Ratio
    negative_returns = [r for r in daily_return_array if r < 0]
    downside_std = (sum([r**2 for r in negative_returns]) / len(negative_returns)) ** 0.5 if negative_returns else 0
    sortino = (annual_return / (downside_std * (252 ** 0.5))) if downside_std > 0 else 0
    
    # Max Drawdown
    max_dd = max(drawdowns) if drawdowns else 0
    
    # Win Rate & Trade Stats
    winning_trades = [t for t in trades if t.get('pnl', 0) > 0]
    losing_trades = [t for t in trades if t.get('pnl', 0) < 0]
    win_rate = len(winning_trades) / len(trades) if trades else 0
    
    avg_win = sum([t.get('pnl', 0) for t in winning_trades]) / len(winning_trades) if winning_trades else 0
    avg_loss = sum([t.get('pnl', 0) for t in losing_trades]) / len(losing_trades) if losing_trades else 0
    profit_factor = abs(sum([t.get('pnl', 0) for t in winning_trades]) / sum([t.get('pnl', 0) for t in losing_trades])) if losing_trades else float('inf')
    
    # Calmar & Recovery Factor
    calmar = annual_return / max_dd if max_dd > 0 else 0
    total_profit = sum([t.get('pnl', 0) for t in trades if t.get('pnl', 0) > 0])
    recovery_factor = total_profit / max_dd if max_dd > 0 else 0
    
    # Ulcer Index (measure of downside volatility)
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

def save_results(run_id, agent_name, symbol, initial_equity, metrics, equity_curve):
    """Save backtest results to database."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("""
    INSERT INTO runs (run_id, agent_name, mode, symbol, initial_equity, final_equity,
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
    
    # Save equity curve
    for bar in equity_curve:
        cursor.execute("""
        INSERT INTO equity_data (run_id, timestamp, equity, cash, positions_value, daily_return)
        VALUES (?, ?, ?, ?, ?, ?)
        """, (
            run_id,
            datetime.now() - timedelta(days=len(equity_curve) - bar['day']),
            bar['equity'],
            bar['cash'],
            bar['positions_value'],
            bar['daily_return']
        ))
    
    conn.commit()
    conn.close()

def main():
    """Run full backtest suite."""
    print("🚀 Starting Agentic Trading Backtest Suite")
    print(f"📅 Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S EDT')}")
    print("=" * 70)
    
    init_database()
    
    # Test multiple agents and symbols
    agents = ['DeepSeek', 'Claude', 'GPT-4']
    symbols = ['AAPL', 'MSFT', 'GOOGL']
    results_summary = []
    
    for agent in agents:
        print(f"\n🤖 Agent: {agent}")
        print("-" * 70)
        
        for symbol in symbols:
            print(f"  📊 {symbol}...", end=' ')
            
            # Generate market data
            market_data = generate_market_data(symbol, days=252)
            
            # Run strategy
            equity_curve, trades, daily_returns, drawdowns = run_trading_strategy(market_data, initial_equity=100000)
            
            # Calculate metrics
            metrics = calculate_metrics(equity_curve, trades, daily_returns, drawdowns, initial_equity=100000)
            
            # Save results
            run_id = f"{agent}_{symbol}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            save_results(run_id, agent, symbol, 100000, metrics, equity_curve)
            
            results_summary.append({
                'agent': agent,
                'symbol': symbol,
                'return': f"{metrics['total_return']*100:.2f}%",
                'sharpe': f"{metrics['sharpe_ratio']:.2f}",
                'max_dd': f"{metrics['max_drawdown']*100:.2f}%",
                'win_rate': f"{metrics['win_rate']*100:.1f}%",
                'trades': metrics['total_trades'],
                'sortino': f"{metrics['sortino_ratio']:.2f}",
                'calmar': f"{metrics['calmar_ratio']:.2f}"
            })
            
            print(f"✅ Return: {metrics['total_return']*100:+.2f}%, Sharpe: {metrics['sharpe_ratio']:.2f}")
    
    print("\n" + "=" * 70)
    print("📈 SUMMARY TABLE")
    print("=" * 70)
    
    # Print summary as table
    if results_summary:
        headers = ['Agent', 'Symbol', 'Return', 'Sharpe', 'Sortino', 'Max DD', 'Win Rate', 'Trades', 'Calmar']
        print(f"{headers[0]:<12} {headers[1]:<8} {headers[2]:<10} {headers[3]:<8} {headers[4]:<8} {headers[5]:<10} {headers[6]:<10} {headers[7]:<8} {headers[8]:<8}")
        print("-" * 100)
        
        for result in results_summary:
            print(f"{result['agent']:<12} {result['symbol']:<8} {result['return']:<10} {result['sharpe']:<8} {result['sortino']:<8} {result['max_dd']:<10} {result['win_rate']:<10} {result['trades']:<8} {result['calmar']:<8}")
    
    print(f"\n✅ Backtest complete! Results saved to {db_path}")
    return results_summary

if __name__ == '__main__':
    results = main()

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Durable producer/consumer bus between agents. Ported from the TradeEase POC:
-- chosen over in-process events because it survives a crash, is inspectable in
-- the UI, and gives every message an audit trail.
CREATE TABLE IF NOT EXISTS agent_signals (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  symbol TEXT,
  confidence REAL,
  data TEXT NOT NULL DEFAULT '{}',          -- JSON payload
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_unconsumed
  ON agent_signals (consumed, signal_type, created_at);

CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  symbol TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_agent_time ON agent_logs (agent, created_at DESC);

-- Every claude invocation, recorded before its result is used.
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd TEXT NOT NULL,                   -- decimal string, never a float
  latency_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  prompt_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_time ON llm_calls (created_at DESC);

-- One row per monthly credit cycle, so spend and tier survive a restart.
CREATE TABLE IF NOT EXISTS budget_cycles (
  id INTEGER PRIMARY KEY,
  cycle_start TEXT NOT NULL UNIQUE,         -- ISO date, first day of the cycle
  budget_usd TEXT NOT NULL,
  spent_usd TEXT NOT NULL DEFAULT '0',
  tier TEXT NOT NULL DEFAULT 'NORMAL',      -- NORMAL | CONSERVE | ESSENTIAL | RULES_ONLY
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

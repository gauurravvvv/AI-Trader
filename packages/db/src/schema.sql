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

-- ── Phase 3: execution ───────────────────────────────────────────────────────

-- Reasoning lineage. INV-2: no order may exist without one.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,                       -- buy | sell
  sue_score TEXT,                           -- decimal string
  audit_score INTEGER,                      -- 0-100, NULL until audited
  audit_tier TEXT,
  conviction INTEGER,
  rationale TEXT,
  thesis_break TEXT NOT NULL DEFAULT '[]',  -- JSON array of clauses
  status TEXT NOT NULL DEFAULT 'PROPOSED',  -- PROPOSED|APPROVED|REJECTED|EXECUTED
  reject_reason TEXT,
  source_signal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions (symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),   -- INV-2
  rung_index INTEGER NOT NULL DEFAULT 0,
  venue TEXT NOT NULL,
  venue_order_id TEXT,
  client_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  qty TEXT NOT NULL,
  limit_price TEXT,
  stop_price TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (decision_id, rung_index)          -- idempotency across restarts
);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders (venue, symbol);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  venue_fill_id TEXT NOT NULL UNIQUE,       -- the same WS event can arrive twice
  qty TEXT NOT NULL,
  price TEXT NOT NULL,
  fee TEXT NOT NULL DEFAULT '0',
  filled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  qty TEXT NOT NULL DEFAULT '0',
  avg_cost TEXT NOT NULL DEFAULT '0',
  realised_pnl TEXT NOT NULL DEFAULT '0',
  opened_at TEXT,
  closed_at TEXT,
  UNIQUE (venue, symbol)
);

CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL REFERENCES positions(id),
  fill_id INTEGER NOT NULL REFERENCES fills(id),
  original_qty TEXT NOT NULL,
  remaining_qty TEXT NOT NULL,
  cost_basis TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lots_position ON lots (position_id, cost_basis DESC);

CREATE TABLE IF NOT EXISTS risk_evaluations (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  passed INTEGER NOT NULL,
  checks TEXT NOT NULL,                     -- JSON array of {name, passed, detail}
  reject_reasons TEXT NOT NULL DEFAULT '[]',
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY,
  venue TEXT NOT NULL,
  matched INTEGER NOT NULL,
  breaks TEXT NOT NULL DEFAULT '[]',
  ran_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global kill switch. One row, id = 1.
CREATE TABLE IF NOT EXISTS system_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  halted INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO system_state (id, halted) VALUES (1, 0);

-- ── Phase 7: notifications (outbox pattern) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_pending ON notifications (status, id);

-- BLOODLINE Schema

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  generation INTEGER DEFAULT 0,
  owner_wallet TEXT NOT NULL,
  agent_wallet TEXT NOT NULL UNIQUE,
  dna TEXT NOT NULL,
  total_pnl REAL DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  total_royalties_paid REAL DEFAULT 0,
  status TEXT DEFAULT 'alive',
  born_at TEXT DEFAULT (datetime('now')),
  last_trade_at TEXT,
  initial_capital REAL DEFAULT 0,
  spawn_cost_blood INTEGER DEFAULT 0,
  FOREIGN KEY (parent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  action TEXT NOT NULL,
  amount_sol REAL NOT NULL,
  token_amount REAL,
  price_at_trade REAL,
  pnl REAL DEFAULT 0,
  tx_signature TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS royalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  amount_sol REAL NOT NULL,
  tx_signature TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spawns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  blood_burned INTEGER NOT NULL,
  mutation_log TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,
  amount_sol REAL NOT NULL,
  method TEXT NOT NULL,
  micro_amount REAL,
  reference TEXT UNIQUE,
  status TEXT DEFAULT 'pending',
  tx_signature TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS pending_spawns (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,
  spawn_cost INTEGER NOT NULL,
  sol_amount REAL NOT NULL,
  micro_amount REAL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_generation ON agents(generation);
CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_id);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_royalties_from ON royalties(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_royalties_to ON royalties(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_spawns_parent ON spawns(parent_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_agent ON withdrawal_requests(agent_id);

-- Scratch Club D1 Schema
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  username TEXT,
  avatar TEXT,
  balance INTEGER DEFAULT 50000,
  is_banned INTEGER DEFAULT 0,
  last_free_ticket INTEGER DEFAULT 0,
  total_won INTEGER DEFAULT 0,
  tickets_scratched INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  price INTEGER NOT NULL,
  prize_amount INTEGER DEFAULT 0,
  prize_type TEXT DEFAULT 'none',
  prize_data TEXT,
  is_scratched INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  scratched_at INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ticket_configs (
  type TEXT PRIMARY KEY,
  price INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  free_cooldown INTEGER DEFAULT 86400,
  name TEXT,
  color TEXT,
  probabilities TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT,
  details TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Default ticket configs (probabilities as JSON array of {chance: number, type, amount, data})
-- Total chance must be 100. 0.01 for special always.
INSERT OR IGNORE INTO ticket_configs (type, price, enabled, free_cooldown, name, color, probabilities) VALUES
('free', 0, 1, 86400, 'Ticket Gratuit', '#FFD700', '[{"chance":0.01,"type":"special","amount":0,"data":"ROLE_SPECIAL"},{"chance":40,"type":"none","amount":0},{"chance":30,"type":"tokens","amount":500},{"chance":20,"type":"tokens","amount":1000},{"chance":9.99,"type":"tokens","amount":2000}]'),
('mini', 1000, 1, 0, 'Mini Scratch', '#00FF7F', '[{"chance":0.01,"type":"special","amount":0,"data":"ROLE_SPECIAL"},{"chance":50,"type":"none","amount":0},{"chance":25,"type":"tokens","amount":2000},{"chance":15,"type":"tokens","amount":5000},{"chance":9.99,"type":"tokens","amount":10000}]'),
('gold', 50000, 1, 0, 'Gold Scratch', '#FFD700', '[{"chance":0.01,"type":"special","amount":0,"data":"ROLE_SPECIAL"},{"chance":40,"type":"none","amount":0},{"chance":30,"type":"tokens","amount":100000},{"chance":20,"type":"tokens","amount":250000},{"chance":9.99,"type":"tokens","amount":500000}]'),
('diamond', 1000000, 1, 0, 'Diamond Scratch', '#C0C0C0', '[{"chance":0.01,"type":"special","amount":0,"data":"ROLE_SPECIAL"},{"chance":35,"type":"none","amount":0},{"chance":30,"type":"tokens","amount":2000000},{"chance":20,"type":"tokens","amount":5000000},{"chance":14.99,"type":"tokens","amount":10000000}]');

-- Migration number: 0001 	 2025-11-30T13:50:00.000Z
CREATE TABLE IF NOT EXISTS queries (
  id TEXT PRIMARY KEY,
  stem TEXT NOT NULL,
  type TEXT NOT NULL,
  a_options TEXT, -- JSON string
  scale_config TEXT, -- JSON string
  cost INTEGER DEFAULT 0,
  created_at TEXT,
  coiner_id INTEGER,
  owner_id INTEGER,
  coiner_fname TEXT,
  coiner_fid INTEGER,
  token_id TEXT,
  casthash TEXT,
  tags TEXT, -- JSON string
  parent TEXT,
  reqs TEXT, -- JSON string
  assets TEXT, -- JSON string
  template BOOLEAN DEFAULT FALSE,
  pub_answers INTEGER DEFAULT 0,
  priv_answers INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_queries_coiner_id ON queries(coiner_id);
CREATE INDEX IF NOT EXISTS idx_queries_created_at ON queries(created_at);
CREATE INDEX IF NOT EXISTS idx_queries_stem ON queries(stem);

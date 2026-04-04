CREATE TABLE IF NOT EXISTS qbase_follows (
  follower_fid INTEGER NOT NULL,
  following_fid INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (follower_fid, following_fid)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON qbase_follows(follower_fid);
CREATE INDEX IF NOT EXISTS idx_follows_following ON qbase_follows(following_fid);

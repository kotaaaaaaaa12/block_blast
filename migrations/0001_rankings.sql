CREATE TABLE IF NOT EXISTS ranking_runs (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  submitted_at INTEGER,
  score INTEGER,
  display_name TEXT,
  day TEXT,
  replay_hash TEXT
);
CREATE INDEX IF NOT EXISTS ranking_runs_expiry ON ranking_runs(expires_at);
CREATE TABLE IF NOT EXISTS ranking_scores (
  player_id TEXT NOT NULL,
  day TEXT NOT NULL,
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score > 0),
  achieved_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, day)
);
CREATE INDEX IF NOT EXISTS ranking_scores_day ON ranking_scores(day, score DESC, achieved_at);
CREATE INDEX IF NOT EXISTS ranking_scores_score ON ranking_scores(score DESC, achieved_at);
CREATE TABLE IF NOT EXISTS ranking_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ranking_limits_expiry ON ranking_limits(expires_at);

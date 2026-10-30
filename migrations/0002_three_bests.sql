CREATE TABLE IF NOT EXISTS ranking_bests (
  player_id TEXT PRIMARY KEY,
  all_score INTEGER NOT NULL CHECK(all_score >= 0),
  all_achieved_at INTEGER NOT NULL,
  today_key TEXT NOT NULL,
  today_score INTEGER NOT NULL CHECK(today_score >= 0),
  today_achieved_at INTEGER NOT NULL,
  week_key TEXT NOT NULL,
  week_score INTEGER NOT NULL CHECK(week_score >= 0),
  week_achieved_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ranking_bests_all ON ranking_bests(all_score DESC, all_achieved_at);
CREATE INDEX IF NOT EXISTS ranking_bests_today ON ranking_bests(today_key, today_score DESC, today_achieved_at);
CREATE INDEX IF NOT EXISTS ranking_bests_week ON ranking_bests(week_key, week_score DESC, week_achieved_at);
CREATE TABLE IF NOT EXISTS ranking_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ranking_players (player_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ranking_runs (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, submitted_at INTEGER, score INTEGER, display_name TEXT, day TEXT, replay_hash TEXT
);
CREATE INDEX IF NOT EXISTS ranking_runs_expiry ON ranking_runs(expires_at);
CREATE TABLE IF NOT EXISTS ranking_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ranking_limits_expiry ON ranking_limits(expires_at);
CREATE TABLE IF NOT EXISTS ranking_admin_sessions (token_hash TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ranking_admin_sessions_expiry ON ranking_admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS ranking_admin_edits (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, day TEXT NOT NULL,
  previous_score INTEGER NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL
);

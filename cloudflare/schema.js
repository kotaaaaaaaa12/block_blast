// Generated from migrations/0001_rankings.sql. Do not edit directly.
export const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS ranking_runs (\n  id TEXT PRIMARY KEY,\n  player_id TEXT NOT NULL,\n  token_hash TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  submitted_at INTEGER,\n  score INTEGER,\n  display_name TEXT,\n  day TEXT,\n  replay_hash TEXT\n)",
  "CREATE INDEX IF NOT EXISTS ranking_runs_expiry ON ranking_runs(expires_at)",
  "CREATE TABLE IF NOT EXISTS ranking_scores (\n  player_id TEXT NOT NULL,\n  day TEXT NOT NULL,\n  display_name TEXT NOT NULL,\n  score INTEGER NOT NULL CHECK(score > 0),\n  achieved_at INTEGER NOT NULL,\n  PRIMARY KEY (player_id, day)\n)",
  "CREATE INDEX IF NOT EXISTS ranking_scores_day ON ranking_scores(day, score DESC, achieved_at)",
  "CREATE INDEX IF NOT EXISTS ranking_scores_score ON ranking_scores(score DESC, achieved_at)",
  "CREATE TABLE IF NOT EXISTS ranking_limits (\n  key TEXT PRIMARY KEY,\n  hits INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS ranking_limits_expiry ON ranking_limits(expires_at)",
  "CREATE TABLE IF NOT EXISTS ranking_players (\n  player_id TEXT PRIMARY KEY,\n  display_name TEXT NOT NULL,\n  updated_at INTEGER NOT NULL\n)"
];

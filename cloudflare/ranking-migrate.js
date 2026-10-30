const MIGRATION = "three-bests-v1";

export async function migrateBests(db, today, week, now) {
  const complete = () => db.prepare("SELECT value FROM ranking_state WHERE key = ?").bind(MIGRATION).first();
  if (await complete()) return;
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ranking_scores', 'ranking_adjustments')").all();
  const names = new Set((tables.results || []).map(row => row.name));
  const statements = [];
  const guard = "NOT EXISTS (SELECT 1 FROM ranking_state WHERE key = 'three-bests-v1')";
  if (names.has("ranking_scores")) {
    const effective = names.has("ranking_adjustments") ? `SELECT s.player_id, s.day, s.achieved_at,
      CASE WHEN a.player_id IS NOT NULL AND s.achieved_at <= a.cutoff_at THEN a.score ELSE s.score END AS score
      FROM ranking_scores s LEFT JOIN ranking_adjustments a ON a.player_id = s.player_id` :
      "SELECT player_id, day, achieved_at, score FROM ranking_scores";
    statements.push(db.prepare(`INSERT INTO ranking_players (player_id, display_name, updated_at)
      SELECT player_id, display_name, ? FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY achieved_at DESC, day DESC) AS choice FROM ranking_scores
      ) WHERE choice = 1 AND ${guard} ON CONFLICT(player_id) DO NOTHING`).bind(now));
    statements.push(db.prepare(`WITH effective AS (${effective}), periods AS (
      SELECT *, 'all' AS period FROM effective
      UNION ALL SELECT *, 'today' AS period FROM effective WHERE day = ?
      UNION ALL SELECT *, 'week' AS period FROM effective WHERE day >= ? AND day <= ?
    ), ordered AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY player_id, period ORDER BY score DESC, achieved_at ASC) AS choice FROM periods
    ) INSERT INTO ranking_bests (player_id, all_score, all_achieved_at, today_key, today_score, today_achieved_at,
      week_key, week_score, week_achieved_at, revision)
    SELECT player_id,
      MAX(CASE WHEN period = 'all' THEN score ELSE 0 END), MAX(CASE WHEN period = 'all' THEN achieved_at ELSE 0 END), ?,
      MAX(CASE WHEN period = 'today' THEN score ELSE 0 END), MAX(CASE WHEN period = 'today' THEN achieved_at ELSE 0 END), ?,
      MAX(CASE WHEN period = 'week' THEN score ELSE 0 END), MAX(CASE WHEN period = 'week' THEN achieved_at ELSE 0 END), 1
    FROM ordered WHERE choice = 1 AND ${guard} GROUP BY player_id ON CONFLICT(player_id) DO NOTHING`)
      .bind(today, week, today, today, week));
  }
  statements.push(db.prepare("INSERT INTO ranking_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(MIGRATION, String(now)));
  // Compaction runs in the same transaction as the transfer of the three bests.
  if (names.has("ranking_scores")) statements.push(db.prepare("DROP TABLE IF EXISTS ranking_scores"));
  if (names.has("ranking_adjustments")) statements.push(db.prepare("DROP TABLE IF EXISTS ranking_adjustments"));
  try { await db.batch(statements); }
  catch (error) {
    // Another isolate may have completed the same migration while this batch waited.
    if (!await complete()) throw error;
  }
}

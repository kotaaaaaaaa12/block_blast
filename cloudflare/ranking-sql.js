export const PERIOD_COLUMNS = {
  all: { score: "all_score", time: "all_achieved_at" },
  today: { score: "today_score", time: "today_achieved_at", key: "today_key" },
  week: { score: "week_score", time: "week_achieved_at", key: "week_key" },
};

export const ADMIN_BEST = `WITH best AS (
  SELECT b.player_id, COALESCE(p.display_name, 'Player') AS name,
    b.all_score AS score, b.all_achieved_at AS achieved_at, b.revision
  FROM ranking_bests b LEFT JOIN ranking_players p ON p.player_id = b.player_id
)`;

// Compare all three slots atomically. Expired periods are replaced, not appended.
export const UPSERT_BESTS = `INSERT INTO ranking_bests
  (player_id, all_score, all_achieved_at, today_key, today_score, today_achieved_at,
    week_key, week_score, week_achieved_at, revision)
  SELECT player_id, score, submitted_at, day, score, submitted_at,
    date(day, 'weekday 0', '-6 days'), score, submitted_at, 1 FROM ranking_runs
  WHERE id = ? AND player_id = ? AND token_hash = ? AND replay_hash = ? AND submitted_at IS NOT NULL
  ON CONFLICT(player_id) DO UPDATE SET
    all_score = max(ranking_bests.all_score, excluded.all_score),
    all_achieved_at = CASE WHEN excluded.all_score > ranking_bests.all_score THEN excluded.all_achieved_at ELSE ranking_bests.all_achieved_at END,
    today_key = max(ranking_bests.today_key, excluded.today_key),
    today_score = CASE WHEN excluded.today_key > ranking_bests.today_key THEN excluded.today_score
      WHEN excluded.today_key = ranking_bests.today_key THEN max(ranking_bests.today_score, excluded.today_score) ELSE ranking_bests.today_score END,
    today_achieved_at = CASE WHEN excluded.today_key > ranking_bests.today_key OR
      (excluded.today_key = ranking_bests.today_key AND excluded.today_score > ranking_bests.today_score)
      THEN excluded.today_achieved_at ELSE ranking_bests.today_achieved_at END,
    week_key = max(ranking_bests.week_key, excluded.week_key),
    week_score = CASE WHEN excluded.week_key > ranking_bests.week_key THEN excluded.week_score
      WHEN excluded.week_key = ranking_bests.week_key THEN max(ranking_bests.week_score, excluded.week_score) ELSE ranking_bests.week_score END,
    week_achieved_at = CASE WHEN excluded.week_key > ranking_bests.week_key OR
      (excluded.week_key = ranking_bests.week_key AND excluded.week_score > ranking_bests.week_score)
      THEN excluded.week_achieved_at ELSE ranking_bests.week_achieved_at END,
    revision = ranking_bests.revision + 1
  WHERE excluded.all_score > ranking_bests.all_score OR excluded.today_key > ranking_bests.today_key OR
    (excluded.today_key = ranking_bests.today_key AND excluded.today_score > ranking_bests.today_score) OR
    excluded.week_key > ranking_bests.week_key OR
    (excluded.week_key = ranking_bests.week_key AND excluded.week_score > ranking_bests.week_score)`;

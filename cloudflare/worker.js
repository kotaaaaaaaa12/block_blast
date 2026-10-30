import { SCHEMA_STATEMENTS } from "./schema.js";
import { validateReplay, RULESET } from "../src/ranking-rules.js";
import { adminApi } from "./admin.js";
import { PERIOD_COLUMNS, UPSERT_BESTS } from "./ranking-sql.js";
import { migrateBests } from "./ranking-migrate.js";

const MAX_BODY = 512 * 1024;
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const ENCODER = new TextEncoder();
const schemaReady = new WeakMap();

export function ensureSchema(db, timezone = "Asia/Tokyo") {
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = db.batch(SCHEMA_STATEMENTS.map(statement => db.prepare(statement)))
      .then(() => {
        const now = Date.now();
        return migrateBests(db, periodStart("today", now, timezone), periodStart("week", now, timezone), now);
      })
      .catch(error => { schemaReady.delete(db); throw error; });
    schemaReady.set(db, ready);
  }
  return ready;
}
const ERROR_CODES = new Map([
  ["Choose all, today, or week.", "invalidPeriod"],
  ["Enter a display name.", "invalidName"],
  ["Use 1–20 characters without control characters or angle brackets.", "invalidName"],
  ["Send application/json.", "invalidRequest"],
  ["Missing request body.", "invalidRequest"],
  ["This replay is too large.", "replayTooLarge"],
  ["Invalid JSON request.", "invalidRequest"],
  ["Use the game website to submit a score.", "wrongOrigin"],
  ["Too many requests. Please try again later.", "rateLimited"],
  ["Start a new game before submitting.", "invalidSession"],
  ["Invalid or outdated game session. Start a new game.", "invalidSession"],
  ["This game session is not available in this browser.", "invalidSession"],
  ["This game session has expired. Start a new game.", "expiredSession"],
  ["This game has already been submitted.", "alreadySubmitted"],
  ["This game has an invalid or unsupported replay length.", "replayTooLarge"],
  ["Invalid replay event.", "invalidReplay"],
  ["Invalid block tray.", "invalidReplay"],
  ["Invalid block placement.", "invalidReplay"],
  ["A block overlaps or leaves the board.", "invalidReplay"],
  ["The submitted score does not match the replay.", "invalidReplay"],
  ["Finish the game before submitting a score.", "unfinishedGame"],
  ["Rankings are not configured yet.", "unavailable"],
]);
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; this.code = ERROR_CODES.get(message) || "requestFailed"; }
}
function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  } });
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", ENCODER.encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("");
}
async function playerIdentity(request, create = false) {
  const secure = new URL(request.url).protocol === "https:";
  const cookieName = secure ? "__Host-bb-player" : "bb-player-local";
  const value = (request.headers.get("Cookie") || "").split(";").map(x => x.trim())
    .find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const valid = /^[a-f0-9]{64}$/.test(value || "");
  if (!valid && !create) return { id: "", cookie: null };
  const token = valid ? value : randomToken();
  return {
    id: await digest(token),
    cookie: `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`,
  };
}
export function periodStart(period, now = Date.now(), timezone = "Asia/Tokyo") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now));
  const get = type => parts.find(x => x.type === type).value;
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  if (period === "all") return "1970-01-01";
  if (period === "today") return today;
  if (period === "week") {
    const monday = new Date(`${today}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    return monday.toISOString().slice(0, 10);
  }
  throw new ApiError(400, "Choose all, today, or week.");
}
export function normalizeName(input) {
  if (typeof input !== "string") throw new ApiError(400, "Enter a display name.");
  const name = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (Array.from(name).length < 1 || Array.from(name).length > 20 || /[\p{Cc}\p{Cf}<>]/u.test(name)) {
    throw new ApiError(400, "Use 1–20 characters without control characters or angle brackets.");
  }
  return name;
}
async function readJson(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "Send application/json.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Missing request body.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new ApiError(413, "This replay is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new ApiError(400, "Invalid JSON request."); }
}
function requireSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new ApiError(403, "Use the game website to submit a score.");
  }
}
async function limit(db, playerId, route) {
  const hour = Math.floor(Date.now() / 3600000);
  const key = `${playerId}:${route}:${hour}`;
  const row = await db.prepare(`INSERT INTO ranking_limits (key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
    .bind(key, (hour + 2) * 3600000).first();
  if (row.hits > 120) throw new ApiError(429, "Too many requests. Please try again later.");
}
async function newSession(request, env) {
  const identity = await playerIdentity(request, true);
  await limit(env.DB, identity.id, "session");
  const token = randomToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO ranking_runs
    (id, player_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, identity.id, await digest(token), now, now + SESSION_LIFETIME).run();
  return json({ runId: id, token, ruleset: RULESET, expiresAt: now + SESSION_LIFETIME }, 201, {
    "Set-Cookie": identity.cookie,
  });
}
async function profile(request, env) {
  const identity = await playerIdentity(request, true);
  if (request.method === "POST") {
    await limit(env.DB, identity.id, "profile");
    const body = await readJson(request);
    const name = normalizeName(body.name);
    await env.DB.prepare(`INSERT INTO ranking_players (player_id, display_name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`)
      .bind(identity.id, name, Date.now()).run();
    return json({ name, profileExists: true }, 200, { "Set-Cookie": identity.cookie });
  }
  const current = await env.DB.prepare("SELECT display_name FROM ranking_players WHERE player_id = ?")
    .bind(identity.id).first();
  return json({ name: current?.display_name || null, profileExists: Boolean(current) }, 200,
    { "Set-Cookie": identity.cookie });
}
async function leaderboard(request, env) {
  const period = new URL(request.url).searchParams.get("period") || "all";
  const timezone = env.RANKING_TIMEZONE || "Asia/Tokyo";
  const start = periodStart(period, Date.now(), timezone);
  const column = PERIOD_COLUMNS[period];
  const values = column.key ? [start] : [];
  const best = `WITH best AS (
    SELECT b.player_id, COALESCE(p.display_name, 'Player') AS display_name,
      b.${column.score} AS score, b.${column.time} AS achieved_at
    FROM ranking_bests b LEFT JOIN ranking_players p ON p.player_id = b.player_id
    WHERE b.${column.score} > 0 ${column.key ? `AND b.${column.key} = ?` : ''}
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, achieved_at ASC, player_id ASC) AS rank FROM best
  )`;
  const identity = await playerIdentity(request);
  const result = await env.DB.prepare(`${best}
    SELECT display_name AS name, score, achieved_at AS achievedAt, rank,
      (player_id = ?) AS mine, (SELECT COUNT(*) FROM best) AS total
    FROM ranked WHERE rank <= 50 OR player_id = ? ORDER BY rank`)
    .bind(...values, identity.id, identity.id).all();
  const rows = result.results || [];
  const entries = rows.filter(row => row.rank <= 50).map(publicEntry);
  const mine = rows.find(row => row.mine);
  return json({ period, timezone, startsOn: start, total: rows[0]?.total || 0,
    entries, me: mine ? publicEntry(mine) : null });
}
function publicEntry(row) {
  return { name: row.name, score: row.score, achievedAt: row.achievedAt, rank: row.rank, mine: Boolean(row.mine) };
}
async function submit(request, env) {
  const identity = await playerIdentity(request);
  if (!identity.id) throw new ApiError(401, "Start a new game before submitting.");
  await limit(env.DB, identity.id, "submit");
  const body = await readJson(request);
  const name = normalizeName(body.name);
  if (typeof body.runId !== "string" || body.runId.length > 64 || !/^[a-f0-9]{64}$/.test(body.token || "") || body.ruleset !== RULESET) {
    throw new ApiError(400, "Invalid or outdated game session. Start a new game.");
  }
  const tokenHash = await digest(body.token);
  const session = await env.DB.prepare(`SELECT * FROM ranking_runs
    WHERE id = ? AND player_id = ? AND token_hash = ?`)
    .bind(body.runId, identity.id, tokenHash).first();
  if (!session) throw new ApiError(401, "This game session is not available in this browser.");
  if (session.expires_at < Date.now()) throw new ApiError(410, "This game session has expired. Start a new game.");
  const replayHash = await digest(JSON.stringify([RULESET, body.score, body.events]));
  const legacyHash = session.submitted_at === null ? null : await digest(JSON.stringify([session.display_name, body.score, body.events]));
  if (session.submitted_at !== null) {
    if (session.replay_hash !== replayHash && session.replay_hash !== legacyHash) throw new ApiError(409, "This game has already been submitted.");
    return json({ saved: true, score: session.score, name: session.display_name, repeated: true });
  }
  let verified;
  try { verified = validateReplay(body.events, body.score); }
  catch (error) { throw new ApiError(400, error.message); }
  const now = Date.now();
  const day = periodStart("today", now, env.RANKING_TIMEZONE || "Asia/Tokyo");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ranking_players (player_id, display_name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(player_id) DO NOTHING`).bind(identity.id, name, now),
    env.DB.prepare(`UPDATE ranking_runs SET submitted_at = ?, score = ?, display_name = ?, day = ?, replay_hash = ?
      WHERE id = ? AND player_id = ? AND token_hash = ? AND submitted_at IS NULL`)
      .bind(now, verified.score, name, day, replayHash, body.runId, identity.id, tokenHash),
    env.DB.prepare(UPSERT_BESTS).bind(body.runId, identity.id, tokenHash, replayHash),
  ]);
  const saved = await env.DB.prepare("SELECT replay_hash, score, display_name FROM ranking_runs WHERE id = ?")
    .bind(body.runId).first();
  if (saved.replay_hash !== replayHash) throw new ApiError(409, "This game has already been submitted.");
  return json({ saved: true, score: saved.score, name: saved.display_name });
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (!env.DB) throw new ApiError(503, "Rankings are not configured yet.");
      await ensureSchema(env.DB, env.RANKING_TIMEZONE || "Asia/Tokyo");
      if (path.startsWith("/api/admin/")) {
        return await adminApi(request, env, { json, readJson, digest, randomToken, periodStart });
      }
      if (path === "/api/health" && request.method === "GET") {
        await env.DB.prepare("SELECT id FROM ranking_runs LIMIT 1").first();
        return json({ ready: true, ruleset: RULESET });
      }
      if (path === "/api/leaderboard" && request.method === "GET") return await leaderboard(request, env);
      if (path === "/api/profile" && request.method === "GET") return await profile(request, env);
      if (request.method === "POST") {
        requireSameOrigin(request);
        if (path === "/api/profile") return await profile(request, env);
        if (path === "/api/session") { await readJson(request); return await newSession(request, env); }
        if (path === "/api/scores") return await submit(request, env);
      }
      return json({ error: "API route not found.", code: "notFound" }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      console.error("Ranking API error:", error);
      return json({ error: "Rankings are temporarily unavailable. You can keep playing and retry later.", code: "unavailable" }, 503);
    }
  },
  async scheduled(_event, env) {
    await ensureSchema(env.DB, env.RANKING_TIMEZONE || "Asia/Tokyo");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ranking_runs WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM ranking_limits WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM ranking_admin_sessions WHERE expires_at < ?").bind(now),
    ]);
  },
};

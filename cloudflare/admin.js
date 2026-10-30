const ENCODER = new TextEncoder();
const LIFETIME = 2 * 60 * 60 * 1000;
const PAGE_SIZE = 30;
import { ADMIN_BEST } from "./ranking-sql.js";

class AdminError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function cookieName(request) {
  return new URL(request.url).protocol === "https:" ? "__Host-bb-admin" : "bb-admin-local";
}
function cookie(request, token, age) {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}` +
    (new URL(request.url).protocol === "https:" ? "; Secure" : "");
}
function readToken(request) {
  const name = cookieName(request);
  const token = (request.headers.get("Cookie") || "").split(";").map(x => x.trim())
    .find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token || "") ? token : null;
}
async function matchesPassword(expected, supplied) {
  if (typeof supplied !== "string" || !supplied || supplied.length > 1024) return false;
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const importKey = value => crypto.subtle.importKey("raw", ENCODER.encode(value), algorithm, false, ["sign", "verify"]);
  const challenge = ENCODER.encode("block-blast-admin-password-v1");
  const signature = await crypto.subtle.sign("HMAC", await importKey(expected), challenge);
  return crypto.subtle.verify("HMAC", await importKey(supplied), signature, challenge);
}
export async function adminApi(request, env, api) {
  const { json, readJson, digest, randomToken, periodStart } = api;
  try {
    const url = new URL(request.url);
    const action = url.pathname.slice("/api/admin/".length);
    const configured = typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length > 0 && env.ADMIN_PASSWORD.length <= 1024;
    const token = readToken(request);
    const tokenHash = token ? await digest(token) : null;
    const secretHash = configured ? await digest(env.ADMIN_PASSWORD) : null;
    const session = tokenHash && configured ? await env.DB.prepare(`SELECT expires_at FROM ranking_admin_sessions
      WHERE token_hash = ? AND secret_hash = ? AND expires_at > ?`).bind(tokenHash, secretHash, Date.now()).first() : null;
    if (action === "session" && request.method === "GET") {
      return json({ configured, authenticated: Boolean(session), expiresAt: session?.expires_at || null });
    }
    if (!configured) throw new AdminError(503, "adminNotConfigured");
    if (request.method === "POST") {
      if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        throw new AdminError(403, "wrongOrigin");
      }
    }
    if (action === "login" && request.method === "POST") {
      const bucket = Math.floor(Date.now() / 900000);
      const ipHash = await digest(request.headers.get("CF-Connecting-IP") || "local");
      const attempt = await env.DB.prepare(`INSERT INTO ranking_limits (key, hits, expires_at) VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
        .bind(`admin-login:${ipHash}:${bucket}`, (bucket + 2) * 900000).first();
      if (attempt.hits > 10) throw new AdminError(429, "adminRateLimited");
      const body = await readJson(request);
      if (!await matchesPassword(env.ADMIN_PASSWORD, body.password)) throw new AdminError(401, "adminWrongPassword");
      const next = randomToken();
      const expiresAt = Date.now() + LIFETIME;
      const statements = [];
      if (tokenHash) statements.push(env.DB.prepare("DELETE FROM ranking_admin_sessions WHERE token_hash = ?").bind(tokenHash));
      statements.push(env.DB.prepare("DELETE FROM ranking_admin_sessions WHERE expires_at <= ?").bind(Date.now()));
      statements.push(env.DB.prepare("INSERT INTO ranking_admin_sessions (token_hash, secret_hash, expires_at) VALUES (?, ?, ?)")
        .bind(await digest(next), secretHash, expiresAt));
      await env.DB.batch(statements);
      return json({ authenticated: true, expiresAt }, 200, { "Set-Cookie": cookie(request, next, LIFETIME / 1000) });
    }
    if (action === "logout" && request.method === "POST") {
      if (tokenHash) await env.DB.prepare("DELETE FROM ranking_admin_sessions WHERE token_hash = ?").bind(tokenHash).run();
      return json({ authenticated: false }, 200, { "Set-Cookie": cookie(request, "", 0) });
    }
    if (!session) throw new AdminError(401, "adminUnauthorized");
    if (action === "scores" && request.method === "GET") {
      const search = (url.searchParams.get("search") || "").trim();
      const page = Number(url.searchParams.get("page") || 1);
      if (search.length > 80 || !Number.isInteger(page) || page < 1 || page > 100000) {
        throw new AdminError(400, "invalidRequest");
      }
      const filter = "WHERE (? = '' OR instr(lower(name), lower(?)) > 0)";
      const result = await env.DB.prepare(`${ADMIN_BEST}
        SELECT player_id AS playerId, name, score, achieved_at AS achievedAt, revision FROM best ${filter}
        ORDER BY score DESC, achieved_at ASC, player_id ASC LIMIT ? OFFSET ?`)
        .bind(search, search, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();
      const count = await env.DB.prepare(`${ADMIN_BEST} SELECT COUNT(*) AS total FROM best ${filter}`).bind(search, search).first();
      return json({ entries: result.results || [], total: count.total, page, pageSize: PAGE_SIZE });
    }
    if (action === "scores" && request.method === "POST") {
      const body = await readJson(request);
      if (body.scope !== "three-bests" || !/^[a-f0-9]{64}$/.test(body.playerId || "") ||
          !Number.isSafeInteger(body.score) || body.score < 0 || body.score > 2147483647 ||
          !Number.isSafeInteger(body.expectedScore) || body.expectedScore < 0 ||
          !Number.isSafeInteger(body.revision) || body.revision < 1) throw new AdminError(400, "adminInvalidScore");
      const editId = crypto.randomUUID();
      const now = Date.now();
      const today = periodStart("today", now, env.RANKING_TIMEZONE || "Asia/Tokyo");
      const week = periodStart("week", now, env.RANKING_TIMEZONE || "Asia/Tokyo");
      const result = await env.DB.batch([
        env.DB.prepare(`${ADMIN_BEST}
          INSERT INTO ranking_admin_edits (id, player_id, day, previous_score, score, created_at)
          SELECT ?, player_id, ?, score, ?, ? FROM best
          WHERE player_id = ? AND score = ? AND revision = ?`)
          .bind(editId, today, body.score, now, body.playerId, body.expectedScore, body.revision),
        env.DB.prepare(`UPDATE ranking_bests SET all_score = ?, all_achieved_at = ?,
          today_key = ?, today_score = ?, today_achieved_at = ?, week_key = ?, week_score = ?, week_achieved_at = ?, revision = revision + 1
          WHERE player_id = ? AND EXISTS (SELECT 1 FROM ranking_admin_edits WHERE id = ?)`)
          .bind(body.score, now, today, body.score, now, week, body.score, now, body.playerId, editId),
      ]);
      if (!result[0].meta?.changes) throw new AdminError(409, "adminConflict");
      return json({ saved: true, removed: body.score === 0, score: body.score });
    }
    return json({ code: "notFound", error: "API route not found." }, 404);
  } catch (error) {
    if (error instanceof AdminError) return json({ code: error.code, error: error.code }, error.status);
    throw error;
  }
}

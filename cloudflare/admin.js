const ENCODER = new TextEncoder();
const LIFETIME = 2 * 60 * 60 * 1000;
const PAGE_SIZE = 30;

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
function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
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
      const timezone = env.RANKING_TIMEZONE || "Asia/Tokyo";
      const start = periodStart(url.searchParams.get("period") || "all", Date.now(), timezone);
      const search = (url.searchParams.get("search") || "").trim();
      const day = url.searchParams.get("day") || "";
      const page = Number(url.searchParams.get("page") || 1);
      const view = url.searchParams.get("view") || "records";
      const playerId = url.searchParams.get("playerId") || "";
      if (search.length > 80 || (day && !validDay(day)) || !Number.isInteger(page) || page < 1 || page > 100000 ||
          !["players", "records"].includes(view) || (playerId && !/^[a-f0-9]{64}$/.test(playerId))) {
        throw new AdminError(400, "invalidRequest");
      }
      const from = `FROM ranking_scores s LEFT JOIN ranking_players p ON p.player_id = s.player_id
        WHERE s.day >= ? AND (? = '' OR s.day = ?)
        AND (? = '' OR instr(lower(COALESCE(p.display_name, s.display_name)), lower(?)) > 0)
        AND (? = '' OR s.player_id = ?)`;
      const args = [start, day, day, search, search, playerId, playerId];
      if (view === "players") {
        const result = await env.DB.prepare(`WITH daily AS (
          SELECT s.player_id AS playerId, COALESCE(p.display_name, s.display_name) AS name,
            s.score, s.day, s.achieved_at AS achievedAt,
            COUNT(*) OVER (PARTITION BY s.player_id) AS recordCount,
            ROW_NUMBER() OVER (PARTITION BY s.player_id ORDER BY s.score DESC, s.achieved_at ASC, s.day DESC) AS choice
          ${from}
        ) SELECT playerId, name, score, day, achievedAt, recordCount FROM daily WHERE choice = 1
          ORDER BY score DESC, achievedAt ASC, playerId ASC LIMIT ? OFFSET ?`)
          .bind(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();
        const count = await env.DB.prepare(`SELECT COUNT(DISTINCT s.player_id) AS total ${from}`).bind(...args).first();
        return json({ entries: result.results || [], total: count.total, page, pageSize: PAGE_SIZE, timezone });
      }
      const result = await env.DB.prepare(`SELECT s.player_id AS playerId, s.day, s.score, s.achieved_at AS achievedAt,
        COALESCE(p.display_name, s.display_name) AS name ${from}
        ORDER BY s.day DESC, s.score DESC, s.player_id ASC LIMIT ? OFFSET ?`)
        .bind(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE).all();
      const count = await env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...args).first();
      return json({ entries: result.results || [], total: count.total, page, pageSize: PAGE_SIZE, timezone });
    }
    if (action === "scores" && request.method === "POST") {
      const body = await readJson(request);
      if (!/^[a-f0-9]{64}$/.test(body.playerId || "") || !validDay(body.day) ||
          !Number.isSafeInteger(body.score) || body.score < 0 || body.score > 2147483647 ||
          !Number.isSafeInteger(body.expectedScore) || body.expectedScore < 1 ||
          !Number.isSafeInteger(body.achievedAt) || body.achievedAt < 0) throw new AdminError(400, "adminInvalidScore");
      const match = "player_id = ? AND day = ? AND score = ? AND achieved_at = ?";
      const values = [body.playerId, body.day, body.expectedScore, body.achievedAt];
      const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO ranking_admin_edits (id, player_id, day, previous_score, score, created_at)
          SELECT ?, player_id, day, score, ?, ? FROM ranking_scores WHERE ${match}`)
          .bind(crypto.randomUUID(), body.score, Date.now(), ...values),
        body.score === 0 ? env.DB.prepare(`DELETE FROM ranking_scores WHERE ${match}`).bind(...values) :
          env.DB.prepare(`UPDATE ranking_scores SET score = ? WHERE ${match}`).bind(body.score, ...values),
      ]);
      if (!result[1].meta?.changes) throw new AdminError(409, "adminConflict");
      return json({ saved: true, removed: body.score === 0, score: body.score });
    }
    return json({ code: "notFound", error: "API route not found." }, 404);
  } catch (error) {
    if (error instanceof AdminError) return json({ code: error.code, error: error.code }, error.status);
    throw error;
  }
}

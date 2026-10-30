import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { periodStart, normalizeName, ensureSchema } from "../cloudflare/worker.js";
import { validateReplay, scoreMove, RULESET } from "../src/ranking-rules.js";
import { SCHEMA_STATEMENTS } from "../cloudflare/schema.js";
import { SHAPES } from "../src/shapes.js";

// Use SQLite to exercise the same parameterized SQL as the D1 binding.
class TestDatabase {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.batchCalls = 0;
  }
  prepare(sql) {
    const database = this.db;
    const wrapped = {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() { return database.prepare(sql).get(...this.values) || null; },
      async all() { return { results: database.prepare(sql).all(...this.values), success: true }; },
      async run() { return { success: true, meta: database.prepare(sql).run(...this.values) }; },
    };
    return wrapped;
  }
  async batch(statements) {
    this.batchCalls += 1;
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

export function completeGame(seed = 841) {
  const board = Array.from({ length: 8 }, () => Array(8).fill(0));
  const state = { score: 0, streak: 0, streakMultiplier: 1, movesSinceLastClear: 0 };
  const names = Object.keys(SHAPES);
  const events = [];
  let randomState = seed;
  const random = n => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState % n;
  };
  let hand = [];
  for (let step = 0; step < 2000; step++) {
    if (!hand.some(Boolean)) {
      hand = Array.from({ length: 3 }, () => names[random(names.length)]);
      events.push(["deal", hand.slice()]);
    }
    const choices = [];
    hand.forEach((name, slot) => {
      if (!name) return;
      const shape = SHAPES[name];
      for (let r = 0; r <= 8 - shape.length; r++) for (let c = 0; c <= 8 - shape[0].length; c++) {
        if (shape.every((line, y) => line.every((cell, x) => !cell || !board[r + y][c + x]))) {
          choices.push([slot, r, c]);
        }
      }
    });
    if (!choices.length) return { events, score: state.score };
    const [slot, r, c] = choices[random(choices.length)];
    const shape = SHAPES[hand[slot]];
    events.push(["move", slot, r, c]);
    let cells = 0;
    shape.forEach((line, y) => line.forEach((cell, x) => {
      if (cell) { board[r + y][c + x] = 1; cells += 1; }
    }));
    hand[slot] = null;
    const rows = [], cols = [];
    for (let i = 0; i < 8; i++) {
      if (board[i].every(Boolean)) rows.push(i);
      if (board.every(line => line[i])) cols.push(i);
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      if (rows.includes(y) || cols.includes(x)) board[y][x] = 0;
    }
    scoreMove(state, cells, rows.length + cols.length);
  }
  throw new Error("The test game did not finish.");
}
const game = completeGame();

function client(env) {
  const cookies = new Map();
  return async (path, body, options = {}) => {
    const request = new Request(`https://game.example${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: "https://game.example" }),
        ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await worker.fetch(request, env);
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      cookies.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    return { response, data: await response.json() };
  };
}
function environment() { return { DB: new TestDatabase(), RANKING_TIMEZONE: "Asia/Tokyo" }; }

function payload(session, extra = {}) {
  return { runId: session.runId, token: session.token, ruleset: RULESET, name: "Kota", ...game, ...extra };
}

test("original scoring keeps two misses and resets on the third", () => {
  const state = { score: 0, streak: 0, streakMultiplier: 1, movesSinceLastClear: 0 };
  assert.equal(scoreMove(state, 2, 1).totalEarned, 12);
  scoreMove(state, 1, 0); scoreMove(state, 1, 0);
  assert.equal(scoreMove(state, 4, 2).totalEarned, 64);
  assert.equal(state.streak, 2);
  for (let i = 0; i < 3; i++) scoreMove(state, 1, 0);
  assert.equal(state.streak, 0);
  assert.equal(scoreMove(state, 1, 1).totalEarned, 11);
});
test("replay verifies a complete game and rejects forged scores and unfinished games", () => {
  assert.equal(validateReplay(game.events, game.score).score, game.score);
  assert.throws(() => validateReplay(game.events, game.score + 1), /score/);
  assert.throws(() => validateReplay([["deal", ["DOT", "DOT", "DOT"]], ["move", 0, 0, 0]], 1), /Finish/);
  assert.throws(() => validateReplay([["deal", ["__proto__", "DOT", "DOT"]], ["move", 0, 0, 0]], 1), /tray/);
  assert.throws(() => validateReplay([["deal", ["DOT", "DOT", "DOT"]], ["move", 0, 0, 0], ["move", 1, 0, 0]], 2), /overlaps/);
  assert.throws(() => validateReplay([["deal", ["DOT", "DOT", "DOT"]], ["move", 0, 8, 0]], 1), /placement/);
});
test("Japan calendar changes day and week at local midnight", () => {
  assert.equal(periodStart("today", Date.parse("2026-10-18T15:00:00Z")), "2026-10-19");
  assert.equal(periodStart("week", Date.parse("2026-10-18T14:59:59Z")), "2026-10-12");
  assert.equal(periodStart("week", Date.parse("2026-10-18T15:00:00Z")), "2026-10-19");
});
test("leaderboard drops previous-day and previous-week scores at Japan midnight", async t => {
  let now = Date.parse("2026-10-18T14:59:59Z");
  t.mock.method(Date, "now", () => now);
  const env = environment();
  const call = client(env);
  const { data: session } = await call("/api/session", {});
  assert.equal((await call("/api/scores", payload(session))).response.status, 200);
  for (const period of ["all", "today", "week"]) {
    const { data, response } = await call(`/api/leaderboard?period=${period}`);
    assert.equal(data.total, 1);
    assert.equal(data.me.score, game.score);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  now += 1000;
  for (const period of ["today", "week"]) {
    const { data } = await call(`/api/leaderboard?period=${period}`);
    assert.equal(data.startsOn, "2026-10-19");
    assert.equal(data.total, 0);
    assert.deepEqual(data.entries, []);
    assert.equal(data.me, null);
  }
  assert.equal((await call("/api/leaderboard?period=all")).data.me.score, game.score);
  const lower = completeGame(12);
  const { data: next } = await call("/api/session", {});
  assert.equal((await call("/api/scores", payload(next, lower))).response.status, 200);
  for (const period of ["today", "week"]) {
    assert.equal((await call(`/api/leaderboard?period=${period}`)).data.me.score, lower.score);
  }
  now += 24 * 60 * 60 * 1000;
  assert.equal((await call("/api/leaderboard?period=today")).data.total, 0);
  assert.equal((await call("/api/leaderboard?period=week")).data.me.score, lower.score);
  assert.equal((await call("/api/leaderboard?period=all")).data.me.score, Math.max(game.score, lower.score));
});
test("display names normalize Unicode and reject markup and control characters", () => {
  assert.equal(normalizeName("  Ｋｏｔａ  "), "Kota");
  assert.throws(() => normalizeName("<script>"));
  assert.throws(() => normalizeName("a\u202Eb"));
  assert.throws(() => normalizeName("a".repeat(21)));
});
test("session, score, idempotent retry, deduplication, and private identity work together", async () => {
  const env = environment();
  const call = client(env);
  const { data: session, response } = await call("/api/session", {});
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.equal((await call("/api/scores", payload(session))).response.status, 200);
  assert.equal((await call("/api/scores", payload(session))).data.repeated, true);
  assert.equal((await call("/api/scores", payload(session, { name: "Another" }))).data.repeated, true);
  const { data: session2 } = await call("/api/session", {});
  assert.equal((await call("/api/scores", payload(session2, { name: "Second name" }))).response.status, 200);
  const { data: ranking } = await call("/api/leaderboard?period=all");
  assert.equal(ranking.total, 1);
  assert.equal(ranking.entries[0].score, game.score);
  assert.equal(ranking.me.rank, 1);
  assert.equal(ranking.entries[0].name, "Kota");
  assert.equal(JSON.stringify(ranking).includes("player_id"), false);
  assert.equal((await call("/api/leaderboard?period=today")).data.total, 1);
  assert.equal((await call("/api/leaderboard?period=week")).data.total, 1);
});
test("API blocks foreign sessions, cross-origin writes, and forged scores", async () => {
  const env = environment();
  const one = client(env), two = client(env);
  const { data: session } = await one("/api/session", {});
  await two("/api/session", {});
  assert.equal((await two("/api/scores", payload(session))).response.status, 401);
  assert.equal((await one("/api/scores", payload(session, { score: game.score + 10 }))).response.status, 400);
  assert.equal((await one("/api/session", {}, { headers: { Origin: "https://other.example" } })).response.status, 403);
  assert.equal((await one("/api/leaderboard?period=bad")).response.status, 400);
});
test("weekly rankings select each player's best and include your rank below the top 50", async () => {
  const env = environment();
  const call = client(env);
  const { data: session } = await call("/api/session", {});
  await call("/api/scores", payload(session));
  const today = periodStart("today");
  for (let i = 0; i < 55; i++) {
    await env.DB.prepare("INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)")
      .bind(`other${i}`, today, `Player ${i}`, game.score + 100 + i, i).run();
  }
  await env.DB.prepare("INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)")
    .bind("other0", "2020-01-01", "Old best", 999999, 0).run();
  const { data: all } = await call("/api/leaderboard?period=all");
  assert.equal(all.entries.length, 50);
  assert.equal(all.total, 56);
  assert.equal(all.me.rank, 56);
  assert.equal(all.entries[0].name, "Old best");
  const { data: daily } = await call("/api/leaderboard?period=today");
  assert.equal(daily.entries[0].name, "Player 54");
});
test("scheduled cleanup removes expired sessions and limits, keeping ranking scores", async () => {
  const env = environment();
  await ensureSchema(env.DB);
  env.DB.db.exec("INSERT INTO ranking_runs VALUES ('old', 'p', 't', 0, 1, NULL, NULL, NULL, NULL, NULL)");
  env.DB.db.exec("INSERT INTO ranking_limits VALUES ('old', 1, 1)");
  env.DB.db.exec("INSERT INTO ranking_scores VALUES ('p', '2026-10-16', 'Player', 10, 1)");
  await worker.scheduled({}, env);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM ranking_runs").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM ranking_limits").first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM ranking_scores").first()).n, 1);
});


test("an empty D1 database initializes once across concurrent first requests", async () => {
  const env = environment();
  const requests = Array.from({ length: 8 }, () => worker.fetch(new Request("https://game.example/api/health"), env));
  const responses = await Promise.all(requests);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(env.DB.batchCalls, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM ranking_scores").first()).n, 0);
});
test("automatic initialization preserves existing scores and retries a failed setup", async () => {
  const env = environment();
  let fail = true;
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async statements => {
    if (fail) { fail = false; throw new Error("Temporary D1 failure"); }
    return batch(statements);
  };
  await assert.rejects(ensureSchema(env.DB), /Temporary/);
  await ensureSchema(env.DB);
  env.DB.db.exec("INSERT INTO ranking_scores VALUES ('p', '2026-10-16', 'Existing player', 123, 1)");
  const newIsolateBinding = new TestDatabase();
  newIsolateBinding.db.close();
  newIsolateBinding.db = env.DB.db;
  await ensureSchema(newIsolateBinding);
  assert.equal((await env.DB.prepare("SELECT score FROM ranking_scores WHERE player_id = 'p'").first()).score, 123);
});
test("the bundled initialization schema matches the canonical migration", () => {
  const sql = readFileSync(new URL("../migrations/0001_rankings.sql", import.meta.url), "utf8");
  assert.deepEqual(SCHEMA_STATEMENTS, sql.split(";").map(statement => statement.trim()).filter(Boolean));
});


test("a device profile renames every ranking while lower scores keep the personal best", async () => {
  const env = environment();
  const call = client(env);
  const profile = await call("/api/profile");
  assert.equal(profile.data.name, null);
  assert.match(profile.response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await call("/api/profile", { name: "Original name" })).response.status, 200);
  const games = Array.from({ length: 8 }, (_, i) => completeGame(i + 1)).sort((a, b) => a.score - b.score);
  const low = games[0], high = games.at(-1);
  assert.ok(high.score > low.score);
  const lowSession = (await call("/api/session", {})).data;
  assert.equal((await call("/api/scores", payload(lowSession, low))).response.status, 200);
  assert.equal((await call("/api/leaderboard")).data.me.score, low.score);
  const session1 = (await call("/api/session", {})).data;
  assert.equal((await call("/api/scores", payload(session1, high))).response.status, 200);
  const initial = (await call("/api/leaderboard?period=all")).data;
  const achievedAt = initial.me.achievedAt;
  assert.equal(initial.me.name, "Original name");
  assert.equal(initial.me.score, high.score);
  const session2 = (await call("/api/session", {})).data;
  assert.equal((await call("/api/scores", payload(session2, low))).response.status, 200);
  let ranking = (await call("/api/leaderboard?period=all")).data;
  assert.equal(ranking.total, 1);
  assert.equal(ranking.me.score, high.score);
  assert.equal(ranking.me.achievedAt, achievedAt);
  assert.equal((await call("/api/profile", { name: "新しい名前" })).response.status, 200);
  for (const period of ["all", "today", "week"]) {
    ranking = (await call(`/api/leaderboard?period=${period}`)).data;
    assert.equal(ranking.me.name, "新しい名前");
    assert.equal(ranking.me.score, high.score);
  }
  assert.equal((await call("/api/profile")).data.name, "新しい名前");
  assert.equal((await call("/api/scores", payload(session1, { ...high, name: "Stale tab" }))).data.repeated, true);
  assert.equal((await call("/api/leaderboard")).data.me.name, "新しい名前");
});
test("profile changes require the same origin and do not affect another browser", async () => {
  const env = environment();
  const one = client(env), two = client(env);
  await one("/api/profile", { name: "First" });
  await two("/api/profile", { name: "Second" });
  assert.equal((await one("/api/profile", { name: "Hijack" }, { headers: { Origin: "https://other.example" } })).response.status, 403);
  assert.equal((await one("/api/profile")).data.name, "First");
  assert.equal((await two("/api/profile")).data.name, "Second");
  const invalid = await one("/api/profile", { name: "<bad>" });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.code, "invalidName");
});

test("admin authentication protects score editing, revokes logout, and expires with password rotation", async t => {
  const env = { ...environment(), ADMIN_PASSWORD: 'test-only-admin-secret-strong' };
  const admin = client(env), stranger = client(env);
  assert.equal((await stranger('/api/admin/session')).data.authenticated, false);
  assert.equal((await stranger('/api/admin/scores')).response.status, 401);
  assert.equal((await admin('/api/admin/login', { password: 'incorrect' })).response.status, 401);
  const login = await admin('/api/admin/login', { password: env.ADMIN_PASSWORD });
  assert.equal(login.response.status, 200);
  assert.match(login.response.headers.get('Set-Cookie'), /__Host-bb-admin=.*HttpOnly; SameSite=Strict; Max-Age=7200; Secure/);
  assert.equal(JSON.stringify(login.data).includes(env.ADMIN_PASSWORD), false);
  assert.equal((await admin('/api/admin/session')).data.authenticated, true);
  assert.equal((await admin('/api/admin/scores')).response.status, 200);
  assert.equal((await stranger('/api/admin/scores')).response.status, 401);
  const oldCookie = login.response.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await admin('/api/admin/logout', {})).response.status, 200);
  const revoked = await worker.fetch(new Request('https://game.example/api/admin/scores', { headers: { Cookie: oldCookie } }), env);
  assert.equal(revoked.status, 401);
  await admin('/api/admin/login', { password: env.ADMIN_PASSWORD });
  env.ADMIN_PASSWORD = 'a-different-test-only-secret';
  assert.equal((await admin('/api/admin/session')).data.authenticated, false);
  assert.equal((await admin('/api/admin/scores')).response.status, 401);
  await admin('/api/admin/login', { password: env.ADMIN_PASSWORD });
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 7200001);
  assert.equal((await admin('/api/admin/scores')).response.status, 401);
  await worker.scheduled({}, env);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM ranking_admin_sessions').get().n, 0);
});

test("admin edits higher and lower daily scores, detects stale writes, audits, and preserves all periods", async () => {
  const env = { ...environment(), ADMIN_PASSWORD: 'test-only-admin-secret-strong' };
  const player = client(env), admin = client(env);
  const { data: session } = await player('/api/session', {});
  await player('/api/scores', payload(session));
  await admin('/api/admin/login', { password: env.ADMIN_PASSWORD });
  const list = (await admin('/api/admin/scores?search=Kota&period=today')).data;
  assert.equal(list.total, 1);
  let row = list.entries[0];
  const edit = score => ({ playerId: row.playerId, day: row.day, achievedAt: row.achievedAt, expectedScore: row.score, score });
  const high = edit(game.score + 500);
  assert.equal((await admin('/api/admin/scores', high)).response.status, 200);
  for (const period of ['all', 'today', 'week']) {
    assert.equal((await player(`/api/leaderboard?period=${period}`)).data.me.score, game.score + 500);
  }
  assert.equal((await player('/api/scores', payload(session))).data.repeated, true);
  assert.equal((await player('/api/leaderboard')).data.me.score, game.score + 500);
  assert.equal((await admin('/api/admin/scores', high)).response.status, 409);
  row = (await admin('/api/admin/scores')).data.entries[0];
  assert.equal((await admin('/api/admin/scores', edit(1))).response.status, 200);
  assert.equal((await player('/api/leaderboard')).data.me.score, 1);
  const { data: next } = await player('/api/session', {});
  assert.equal((await player('/api/scores', payload(next))).response.status, 200);
  assert.equal((await player('/api/leaderboard')).data.me.score, game.score);
  row = (await admin('/api/admin/scores')).data.entries[0];
  const priorDay = new Date(Date.parse(row.day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  await env.DB.prepare('INSERT INTO ranking_scores (player_id, day, display_name, score, achieved_at) VALUES (?, ?, ?, ?, ?)')
    .bind(row.playerId, priorDay, 'Kota', 50, row.achievedAt - 86400000).run();
  assert.equal((await admin('/api/admin/scores', edit(0))).response.status, 200);
  assert.equal((await player('/api/leaderboard?period=today')).data.me, null);
  assert.equal((await player('/api/leaderboard?period=all')).data.me.score, 50);
  assert.equal((await admin(`/api/admin/scores?day=${priorDay}`)).data.total, 1);
  const audit = env.DB.db.prepare('SELECT previous_score, score FROM ranking_admin_edits ORDER BY created_at, rowid').all();
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map(r => r.score), [game.score + 500, 1, 0]);
  const publicRanking = JSON.stringify((await player('/api/leaderboard')).data);
  assert.equal(publicRanking.includes(row.playerId), false);
});

test("admin rejects cross-origin requests, malformed edits, and brute-force login attempts", async () => {
  const env = { ...environment(), ADMIN_PASSWORD: 'test-only-admin-secret-strong' };
  const call = client(env);
  assert.equal((await call('/api/admin/login', { password: env.ADMIN_PASSWORD }, { headers: { Origin: 'https://other.example' } })).response.status, 403);
  const missingOrigin = await worker.fetch(new Request('https://game.example/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
  }), env);
  assert.equal(missingOrigin.status, 403);
  await call('/api/admin/login', { password: env.ADMIN_PASSWORD });
  for (const score of [-1, 0.5, '200', 2147483648, null]) {
    assert.equal((await call('/api/admin/scores', { playerId: 'a'.repeat(64), day: '2026-10-29', expectedScore: 100, achievedAt: 1, score })).response.status, 400);
  }
  assert.equal((await call('/api/admin/scores?day=2026-02-30')).response.status, 400);
  assert.equal((await call('/api/admin/scores?page=-1')).response.status, 400);
  assert.equal((await call('/api/admin/scores', {}, { headers: { Origin: 'https://other.example' } })).response.status, 403);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM ranking_admin_edits').get().n, 0);
  const limited = client({ ...environment(), ADMIN_PASSWORD: 'test-only-admin-secret-strong' });
  for (let i = 0; i < 10; i++) assert.equal((await limited('/api/admin/login', { password: 'wrong' })).response.status, 401);
  assert.equal((await limited('/api/admin/login', { password: 'test-only-admin-secret-strong' })).response.status, 429);
  const disabled = client(environment());
  assert.equal((await disabled('/api/admin/session')).data.configured, false);
  assert.equal((await disabled('/api/admin/login', { password: '' })).response.status, 503);
  assert.equal((await disabled('/api/leaderboard')).response.status, 200);
});

test("admin paginates and searches literal names without exposing additional records", async () => {
  const env = { ...environment(), ADMIN_PASSWORD: 'test-only-admin-secret-strong' };
  await ensureSchema(env.DB);
  const today = periodStart('today');
  for (let i = 0; i < 35; i++) await env.DB.prepare('INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)')
    .bind(i.toString(16).padStart(64, '0'), today, i === 1 ? '100%_Player' : `Player ${i}`, i + 1, i + 1).run();
  const call = client(env); await call('/api/admin/login', { password: env.ADMIN_PASSWORD });
  const first = (await call('/api/admin/scores')).data;
  const second = (await call('/api/admin/scores?page=2')).data;
  assert.equal(first.total, 35); assert.equal(first.entries.length, 30); assert.equal(second.entries.length, 5);
  assert.equal(new Set([...first.entries, ...second.entries].map(r => r.playerId)).size, 35);
  assert.equal((await call('/api/admin/scores?search=%25_')).data.total, 1);
  assert.equal((await call('/api/admin/scores?search=%27%20OR%201%3D1--')).data.total, 0);
});

test("admin groups daily history by browser identity before pagination and preserves equal-name players", async () => {
  const env = { ...environment(), ADMIN_PASSWORD: 'test-only-admin-secret-strong' };
  await ensureSchema(env.DB);
  const today = periodStart('today');
  const target = 'a'.repeat(64), other = 'b'.repeat(64);
  for (let i = 0; i < 65; i++) {
    const day = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10);
    await env.DB.prepare('INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)')
      .bind(target, day, 'Same name', i + 1, i + 1).run();
  }
  await env.DB.prepare('INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)').bind(other, today, 'Same name', 100, 1).run();
  for (let i = 0; i < 33; i++) await env.DB.prepare('INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)')
    .bind(i.toString(16).padStart(64, '0'), today, `Player ${i}`, 10, i + 1).run();
  const call = client(env); await call('/api/admin/login', { password: env.ADMIN_PASSWORD });
  const first = (await call('/api/admin/scores?view=players')).data;
  const second = (await call('/api/admin/scores?view=players&page=2')).data;
  assert.equal(first.total, 35); assert.equal(first.entries.length, 30); assert.equal(second.entries.length, 5);
  const players = [...first.entries, ...second.entries];
  assert.equal(new Set(players.map(x => x.playerId)).size, 35);
  assert.equal(players.filter(x => x.name === 'Same name').length, 2);
  const grouped = players.find(x => x.playerId === target);
  assert.equal(grouped.recordCount, 65); assert.equal(grouped.score, 65);
  const history = (await call(`/api/admin/scores?playerId=${target}`)).data;
  const last = (await call(`/api/admin/scores?playerId=${target}&page=3`)).data;
  assert.equal(history.total, 65); assert.equal(history.entries.length, 30); assert.equal(last.entries.length, 5);
  assert.ok([...history.entries, ...last.entries].every(x => x.playerId === target));
  const daily = (await call('/api/admin/scores?view=players&period=today&search=Same')).data;
  assert.equal(daily.total, 2);
  assert.ok(daily.entries.every(x => x.recordCount === 1));
  const edit = { ...history.entries[0], expectedScore: history.entries[0].score, score: 500 };
  assert.equal((await call('/api/admin/scores', edit)).response.status, 200);
  const updated = (await call('/api/admin/scores?view=players&search=Same')).data;
  assert.equal(updated.total, 2);
  assert.equal(updated.entries.find(x => x.playerId === target).score, 500);
  assert.equal(updated.entries.find(x => x.playerId === target).recordCount, 65);
  assert.equal((await call('/api/admin/scores?view=players&playerId=invalid')).response.status, 400);
});

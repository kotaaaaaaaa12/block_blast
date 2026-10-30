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
    this.pending = Promise.resolve();
  }
  prepare(sql) {
    const database = this.db;
    const wrapped = {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      async first() { return database.prepare(sql).get(...this.values) || null; },
      async all() { return { results: database.prepare(sql).all(...this.values), success: true }; },
      async run() { return { success: true, meta: database.prepare(sql).run(...this.values) }; },
    };
    return wrapped;
  }
  async batch(statements) {
    this.batchCalls++;
    const work = this.pending.then(async () => {
      this.db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.db.exec("COMMIT"); return results;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
    this.pending = work.catch(() => {});
    return work;
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

function raw(env, id) { return env.DB.db.prepare('SELECT * FROM ranking_bests WHERE player_id=?').get(id); }
async function seed(env, id, scores, options = {}) {
  await ensureSchema(env.DB);
  const now = options.now ?? Date.now(), today = periodStart('today', now), week = periodStart('week', now);
  await env.DB.prepare('INSERT INTO ranking_players VALUES (?, ?, ?) ON CONFLICT(player_id) DO NOTHING').bind(id, options.name || 'Kota', now).run();
  await env.DB.prepare('INSERT INTO ranking_bests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, scores[0], now - 3, today, scores[1], now - 2, week, scores[2], now - 1, 1).run();
}
async function runFor(call, env, value = game) {
  const { data: session } = await call('/api/session', {});
  const id = env.DB.db.prepare('SELECT player_id FROM ranking_runs WHERE id=?').get(session.runId).player_id;
  return { session, id, send: () => call('/api/scores', payload(session, value)) };
}
function watchWrites(env) {
  env.DB.db.exec(`CREATE TABLE write_count(n INTEGER); INSERT INTO write_count VALUES(0);
    CREATE TRIGGER best_insert AFTER INSERT ON ranking_bests BEGIN UPDATE write_count SET n=n+1; END;
    CREATE TRIGGER best_update AFTER UPDATE ON ranking_bests BEGIN UPDATE write_count SET n=n+1; END;`);
  return () => env.DB.db.prepare('SELECT n FROM write_count').get().n;
}
const legacySql = readFileSync(new URL('../migrations/0001_rankings.sql', import.meta.url), 'utf8');
async function legacyRow(env, id, day, score, at, name = 'Legacy') {
  await env.DB.prepare('INSERT INTO ranking_scores VALUES (?, ?, ?, ?, ?)').bind(id, day, name, score, at).run();
}

test('original scoring and replay validation reject unfinished or forged games', () => {
  const state = { score: 0, streak: 0, streakMultiplier: 1, movesSinceLastClear: 0 };
  assert.equal(scoreMove(state, 2, 1).totalEarned, 12);
  scoreMove(state, 1, 0); scoreMove(state, 1, 0); assert.equal(scoreMove(state, 4, 2).totalEarned, 64);
  for (let i=0;i<3;i++) scoreMove(state,1,0); assert.equal(state.streak,0);
  assert.equal(validateReplay(game.events,game.score).score,game.score);
  assert.throws(()=>validateReplay(game.events,game.score+1),/score/);
  assert.throws(()=>validateReplay([['deal',['DOT','DOT','DOT']],['move',0,0,0]],1),/Finish/);
  assert.throws(()=>validateReplay([['deal',['__proto__','DOT','DOT']]],1));
});
test('names and Japan day/week keys are validated', () => {
  assert.equal(normalizeName(' Ｋｏｔａ '),'Kota'); assert.throws(()=>normalizeName('<script>')); assert.throws(()=>normalizeName('a\u202Eb'));
  assert.equal(periodStart('today',Date.parse('2026-10-18T15:00:00Z')),'2026-10-19');
  assert.equal(periodStart('week',Date.parse('2026-10-18T14:59:59Z')),'2026-10-12');
  assert.equal(periodStart('week',Date.parse('2026-10-18T15:00:00Z')),'2026-10-19');
});
test('first game stores one row with exactly three best-score values; retries are idempotent', async () => {
  const env=environment(),call=client(env),run=await runFor(call,env);
  assert.equal((await run.send()).response.status,200);
  const before={...raw(env,run.id)};
  assert.deepEqual([before.all_score,before.today_score,before.week_score],[game.score,game.score,game.score]);
  assert.equal((await run.send()).data.repeated,true);
  assert.deepEqual({...raw(env,run.id)},before);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_bests').get().n,1);
  for(const period of ['all','today','week']) assert.equal((await call('/api/leaderboard?period='+period)).data.me.score,game.score);
});
test('each best is compared independently and equal scores preserve achievement times', async () => {
  const cases=[
    {start:[game.score+100,1,1],want:[game.score+100,game.score,game.score]},
    {start:[game.score+100,1,game.score+50],want:[game.score+100,game.score,game.score+50]},
    {start:[1,1,1],want:[game.score,game.score,game.score]},
  ];
  for(const {start,want} of cases){
    const env=environment(),call=client(env),run=await runFor(call,env);
    await seed(env,run.id,start); const before=raw(env,run.id);
    assert.equal((await run.send()).response.status,200);const after=raw(env,run.id);
    assert.deepEqual([after.all_score,after.today_score,after.week_score],want);
    if(start[0]===want[0])assert.equal(after.all_achieved_at,before.all_achieved_at);
  }
  const env=environment(),call=client(env),run=await runFor(call,env);await seed(env,run.id,[game.score,game.score,game.score]);
  const before={...raw(env,run.id)};await run.send();assert.deepEqual({...raw(env,run.id)},before);
});
test('non-record games never write the ranking row and storage stays at one row per player', async () => {
  const env=environment(),call=client(env),first=await runFor(call,env);
  await seed(env,first.id,[game.score+100,game.score+100,game.score+100]);
  const writes=watchWrites(env),before={...raw(env,first.id)};
  await first.send();
  for(let i=0;i<20;i++){const run=await runFor(call,env);assert.equal((await run.send()).response.status,200);}
  assert.equal(writes(),0);assert.deepEqual({...raw(env,first.id)},before);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_bests').get().n,1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('ranking_scores','ranking_adjustments')").get().n,0);
});
test('day and week reset without writes or clearing all time; new lower scores fill expired slots', async t => {
  let now=Date.parse('2026-10-20T14:59:59Z');t.mock.method(Date,'now',()=>now);
  const env=environment(),call=client(env),first=await runFor(call,env);
  await seed(env,first.id,[game.score+1000,game.score+100,game.score+500],{now});
  const writes=watchWrites(env);now+=1000;
  assert.equal((await call('/api/leaderboard?period=today')).data.total,0);
  assert.equal((await call('/api/leaderboard?period=week')).data.me.score,game.score+500);assert.equal(writes(),0);
  const second=await runFor(call,env);await second.send();let row=raw(env,first.id);
  assert.deepEqual([row.all_score,row.today_score,row.week_score],[game.score+1000,game.score,game.score+500]);
  now=Date.parse('2026-10-25T15:00:00Z');
  assert.equal((await call('/api/leaderboard?period=week')).data.total,0);
  const third=await runFor(call,env);await third.send();row=raw(env,first.id);
  assert.deepEqual([row.all_score,row.today_score,row.week_score],[game.score+1000,game.score,game.score]);
  assert.equal(row.week_key,'2026-10-26');assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_bests').get().n,1);
});
test('concurrent legal submissions retain the maximum and do not create extra score rows', async () => {
  const env=environment(),call=client(env);const low=completeGame(12),high=completeGame(99);
  const a=await runFor(call,env,low),b=await runFor(call,env,high);
  const result=await Promise.all([a.send(),b.send()]);assert.ok(result.every(r=>r.response.status===200));
  const row=raw(env,a.id);assert.deepEqual([row.all_score,row.today_score,row.week_score],Array(3).fill(Math.max(low.score,high.score)));
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_bests').get().n,1);
});
test('profile changes update all rankings while browser identities remain isolated', async () => {
  const env=environment(),one=client(env),two=client(env);const a=await runFor(one,env);await a.send();
  const b=await runFor(two,env);await b.send();await one('/api/profile',{name:'New name'});
  for(const period of ['all','today','week']){
    const data=(await one('/api/leaderboard?period='+period)).data;
    assert.equal(data.total,2);assert.equal(data.me.name,'New name');assert.equal((await two('/api/leaderboard?period='+period)).data.me.name,'Kota');
  }
});
test('sessions, origins, replay claims and parameter validation reject invalid requests', async () => {
  const env=environment(),one=client(env),two=client(env),a=await runFor(one,env);await runFor(two,env);
  assert.equal((await two('/api/scores',payload(a.session))).response.status,401);
  assert.equal((await one('/api/scores',payload(a.session,{score:game.score+10}))).response.status,400);
  assert.equal((await one('/api/session',{}, {headers:{Origin:'https://other.example'}})).response.status,403);
  assert.equal((await one('/api/leaderboard?period=invalid')).response.status,400);
});
test('leaderboards include the current player below the top 50 without leaking identity fields', async () => {
  const env=environment(),call=client(env),run=await runFor(call,env);await run.send();
  for(let i=0;i<55;i++)await seed(env,i.toString(16).padStart(64,'0'),Array(3).fill(game.score+100+i),{name:`Other ${i}`});
  const data=(await call('/api/leaderboard?period=week')).data;
  assert.equal(data.total,56);assert.equal(data.entries.length,50);assert.equal(data.me.rank,56);assert.equal(JSON.stringify(data).includes(run.id),false);
});
test('automatic initialization shares a promise, runs compaction once and retries failures', async () => {
  const db=new TestDatabase();const a=ensureSchema(db),b=ensureSchema(db);assert.equal(a,b);await Promise.all([a,b]);
  assert.equal(db.batchCalls,2);await ensureSchema(db);assert.equal(db.batchCalls,2);
  const retry=new TestDatabase(),batch=retry.batch.bind(retry);let failed=false;
  retry.batch=async statements=>{if(!failed){failed=true;throw new Error('temporary');}return batch(statements);};
  await assert.rejects(ensureSchema(retry));await ensureSchema(retry);
});
test('current schema contains no daily-history tables and matches the bundled schema', () => {
  const sql=readFileSync(new URL('../migrations/0002_three_bests.sql',import.meta.url),'utf8');
  assert.deepEqual(SCHEMA_STATEMENTS,sql.split(';').map(x=>x.trim()).filter(Boolean));
  assert.equal(SCHEMA_STATEMENTS.some(x=>/CREATE TABLE.*ranking_scores/.test(x)),false);
});
test('migration compacts old daily history and corrections into three independent bests', async t => {
  const now=Date.parse('2026-10-30T03:00:00Z');t.mock.method(Date,'now',()=>now);
  const env=environment();env.DB.db.exec(legacySql);
  await legacyRow(env,'a','2026-10-01',1000,1);await legacyRow(env,'a','2026-10-28',500,2);await legacyRow(env,'a','2026-10-30',100,3);
  await env.DB.prepare('INSERT INTO ranking_players VALUES (?,?,?)').bind('a','Current name',4).run();
  await legacyRow(env,'b','2026-10-29',900,10);await legacyRow(env,'b','2026-10-30',800,20);
  await env.DB.prepare('INSERT INTO ranking_adjustments VALUES (?,?,?,?)').bind('b',50,30,'old-edit').run();
  await legacyRow(env,'c','2026-10-29',400,10);await env.DB.prepare('INSERT INTO ranking_adjustments VALUES (?,?,?,?)').bind('c',0,30,'hide').run();
  await ensureSchema(env.DB);
  assert.deepEqual([raw(env,'a').all_score,raw(env,'a').today_score,raw(env,'a').week_score],[1000,100,500]);
  assert.deepEqual([raw(env,'b').all_score,raw(env,'b').today_score,raw(env,'b').week_score],[50,50,50]);
  assert.equal(raw(env,'c').all_score,0);
  assert.equal(env.DB.db.prepare('SELECT display_name FROM ranking_players WHERE player_id=?').get('a').display_name,'Current name');
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('ranking_scores','ranking_adjustments')").get().n,0);
  const snapshot=env.DB.db.prepare('SELECT * FROM ranking_bests ORDER BY player_id').all();
  const binding={prepare:env.DB.prepare.bind(env.DB),batch:env.DB.batch.bind(env.DB)};await ensureSchema(binding);
  assert.deepEqual(env.DB.db.prepare('SELECT * FROM ranking_bests ORDER BY player_id').all(),snapshot);
});
test('migration supports old databases without corrections and rolls back before dropping history on failure', async () => {
  const env=environment();env.DB.db.exec(legacySql);env.DB.db.exec('DROP TABLE ranking_adjustments');
  await legacyRow(env,'a',periodStart('today'),321,1);
  const batch=env.DB.batch.bind(env.DB);let fail=true;
  env.DB.batch=async statements=>{
    if(fail&&statements.some(x=>x.sql.startsWith('DROP TABLE'))){
      fail=false;
      const index=statements.findIndex(x=>x.sql.startsWith('DROP TABLE'));
      return batch([...statements.slice(0,index),env.DB.prepare('INSERT INTO missing_table VALUES(1)'),...statements.slice(index)]);
    }
    return batch(statements);
  };
  await assert.rejects(ensureSchema(env.DB));assert.equal(env.DB.db.prepare('SELECT score FROM ranking_scores').get().score,321);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_bests').get().n,0);
  await ensureSchema(env.DB);assert.equal(raw(env,'a').all_score,321);
});
test('scheduled cleanup expires temporary records while retaining the three bests', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);const env=environment(),call=client(env),run=await runFor(call,env);await run.send();
  const before={...raw(env,run.id)};now+=8*86400000;await worker.scheduled({},env);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_runs').get().n,0);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_limits').get().n,0);
  assert.deepEqual({...raw(env,run.id)},before);
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
    assert.equal((await call('/api/admin/scores', { scope: 'three-bests', playerId: 'a'.repeat(64), day: '2026-10-29', revision: 1, expectedScore: 100, achievedAt: 1, score })).response.status, 400);
  }
  assert.equal((await call('/api/admin/scores?search=' + 'x'.repeat(81))).response.status, 400);
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

test('admin edits all three slots atomically, catches stale versions and permits zero/restore', async t => {
  let now=Date.parse('2026-10-30T03:00:00Z');t.mock.method(Date,'now',()=>now);
  const env={...environment(),ADMIN_PASSWORD:'test-only-admin-secret-strong'},call=client(env),run=await runFor(call,env);await run.send();
  await call('/api/admin/login',{password:env.ADMIN_PASSWORD});
  const get=async()=>(await call('/api/admin/scores')).data.entries[0];
  let row=await get();const stale={...row,scope:'three-bests',expectedScore:row.score,score:8888};
  const edit=score=>call('/api/admin/scores',{...row,scope:'three-bests',expectedScore:row.score,score});
  for(const score of [game.score+1000,1,0,game.score+2000]){
    assert.equal((await edit(score)).response.status,200);
    for(const period of ['all','today','week']){
      const data=(await call('/api/leaderboard?period='+period)).data;
      if(score===0)assert.equal(data.me,null);else assert.equal(data.me.score,score);
    }
    assert.deepEqual([raw(env,run.id).all_score,raw(env,run.id).today_score,raw(env,run.id).week_score],Array(3).fill(score));
    row=await get();assert.equal(typeof row.revision,'number');assert.equal(row.score,score);
  }
  assert.equal((await call('/api/admin/scores',stale)).response.status,409);
  assert.equal((await call('/api/admin/scores',{...row,scope:'best',expectedScore:row.score,score:10})).response.status,400);
  await run.send();assert.equal((await get()).score,game.score+2000);
  row=await get();await edit(1);
  const next=await runFor(call,env);await next.send();assert.equal((await get()).score,game.score);
  row=await get();const staleSmall={...row,scope:'three-bests',expectedScore:row.score,score:5};
  await edit(row.score);assert.equal((await call('/api/admin/scores',staleSmall)).response.status,409);
  now=Date.parse('2026-11-01T15:00:00Z');
  assert.equal((await call('/api/leaderboard?period=today')).data.total,0);
  assert.equal((await call('/api/leaderboard?period=week')).data.total,0);
  assert.equal((await call('/api/leaderboard?period=all')).data.me.score,game.score);
});
test('admin search/pagination lists one record per identity and treats equal names as separate browsers', async () => {
  const env={...environment(),ADMIN_PASSWORD:'test-only-admin-secret-strong'};
  for(let i=0;i<35;i++)await seed(env,i.toString(16).padStart(64,'0'),[100+i,10+i,50+i],{name:i<2?'Same name':i===2?'100%_Player':`Player ${i}`});
  const call=client(env);await call('/api/admin/login',{password:env.ADMIN_PASSWORD});
  const a=(await call('/api/admin/scores')).data,b=(await call('/api/admin/scores?page=2')).data;
  assert.equal(a.total,35);assert.equal(a.entries.length,30);assert.equal(b.entries.length,5);
  assert.equal(new Set([...a.entries,...b.entries].map(x=>x.playerId)).size,35);
  assert.equal((await call('/api/admin/scores?search=Same')).data.total,2);
  assert.equal((await call('/api/admin/scores?search=%25_')).data.total,1);
  assert.equal((await call('/api/admin/scores?search=%27%20OR%201%3D1--')).data.total,0);
});
test('two cold bindings can initialize and compact the same legacy database safely', async () => {
  const env=environment();env.DB.db.exec(legacySql);
  await legacyRow(env,'a',periodStart('today'),234,1);
  const other={prepare:env.DB.prepare.bind(env.DB),batch:env.DB.batch.bind(env.DB)};
  await Promise.all([ensureSchema(env.DB),ensureSchema(other)]);
  assert.equal(raw(env,'a').all_score,234);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM ranking_bests').get().n,1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='ranking_scores'").get().n,0);
});

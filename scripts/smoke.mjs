// Destructive fault scenarios are restricted to the dedicated lb-smoke project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const base = 'http://127.0.0.1:13000';
const results = [], requests = [];
const started = new Date().toISOString();
const compose = (...args) => execFileSync('docker', ['compose', '--env-file', 'scripts/smoke.env', '-p', 'lb-smoke', ...args], { encoding: 'utf8', timeout: 90000 });
const sql = (query) => compose('exec', '-T', 'postgres', 'psql', '-U', 'leaderboard', '-d', 'leaderboard', '-v', 'ON_ERROR_STOP=1', '-Atc', query).trim();
async function request(path, status = 200, body, root = base) {
  const method = body === undefined ? 'GET' : 'POST';
  const start = Date.now();
  const response = await fetch(root + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  requests.push({ method, url: root + path, request: body, status: response.status, expectedStatus: status, ms: Date.now() - start, response: data });
  assert.equal(response.status, status, `${method} ${path}: ${raw}`);
  return data;
}
const post = (id, delta, status = 200) => request('/score', status, { player_id: id, score_delta: delta });
const rank = (id, n = 1) => request(`/leaderboard/rank/${encodeURIComponent(id)}?n=${n}`);
async function eventually(fn) {
  const deadline = Date.now() + 25000;
  let last;
  do { try { return await fn(); } catch (e) { last = e; await sleep(200); } } while (Date.now() < deadline);
  throw last;
}
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; if (name.startsWith('01:')) throw error; }
}
try {
  await check('01: liveness/readiness and empty season', async () => {
    await eventually(() => request('/ready'));
    assert.deepEqual(await request('/health'), { status: 'ok' });
    assert.deepEqual(await request('/ready'), { status: 'ok', postgres: true, redis: true });
    assert.deepEqual((await request('/leaderboard/top')).entries, [], 'Use a fresh lb-smoke volume');
    assert.equal((await request('/leaderboard/rank/missing', 404)).error, 'player_not_ranked');
  });
  await check('02: accumulate, negative score, tie order and neighbours', async () => {
    assert.equal((await post('alice', 100)).score, 100);
    await post('bob', 100); await post('carol', 50);
    assert.equal((await post('negative', -5)).score, -5);
    await eventually(async () => assert.deepEqual((await request('/leaderboard/top')).entries.map(e => e.player_id), ['alice', 'bob', 'carol', 'negative']));
    let r = await rank('bob');
    assert.deepEqual(r.player, { player_id: 'bob', score: 100, rank: 2 });
    assert.equal(r.above[0].player_id, 'alice'); assert.equal(r.below[0].player_id, 'carol');
    assert.equal((await post('alice', 50)).score, 150);
    assert.equal((await post('alice', -50)).score, 100);
    await eventually(async () => assert.equal((await rank('alice')).player.rank, 2));
    assert.deepEqual((await rank('bob')).above, []);
    assert.deepEqual((await rank('negative')).below, []);
    r = await rank('alice', 0); assert.deepEqual(r.above, []); assert.deepEqual(r.below, []);
    assert.equal((await request('/leaderboard/top?limit=1')).entries.length, 1);
    await request('/leaderboard/top?limit=1000'); await rank('alice', 50);
    await request('/leaderboard/rank/alice');
  });
  await check('03: parallel updates and repeated request semantics', async () => {
    await post('repeat', 7); assert.equal((await post('repeat', 7)).score, 14);
    const replies = await Promise.all(Array.from({ length: 20 }, () => post('parallel', 1)));
    assert.deepEqual(replies.map(r => r.score).sort((a,b) => a-b), Array.from({ length: 20 }, (_,i) => i+1));
    await eventually(async () => assert.equal((await rank('parallel')).player.score, 20));
  });
  await check('04: validation of all business endpoints', async () => {
    for (const body of [{}, { player_id: 'x' }, { score_delta: 1 }, { player_id: '', score_delta: 1 }, { player_id: 'x'.repeat(129), score_delta: 1 }, ...[0, 1.5, 2097152, -2097152, 'bad'].map(score_delta => ({ player_id: 'invalid', score_delta }))]) {
      const r = await request('/score', 400, body); assert.equal(r.statusCode, 400); assert.equal(typeof r.message, 'string');
    }
    for (const limit of ['0', '-1', '1001', '1.5', 'bad']) await request(`/leaderboard/top?limit=${limit}`, 400);
    for (const n of ['-1', '51', '1.5', 'bad']) await request(`/leaderboard/rank/alice?n=${n}`, 400);
    await request(`/leaderboard/rank/${'x'.repeat(129)}`, 400);
    const id = 'игрок /?#😀'; await post(id, 1);
    await eventually(async () => assert.equal((await rank(id)).player.player_id, id));
    await post('x'.repeat(128), 1);
    await eventually(() => rank('x'.repeat(128)));
  });
  await check('05: score bounds and rollback on overflow', async () => {
    for (const [id, value, delta] of [['max', 2097151, 1], ['min', -2097151, -1]]) {
      await post(id, value);
      assert.equal((await post(id, delta, 422)).error, 'score_out_of_range');
      await eventually(async () => assert.equal((await rank(id)).player.score, value));
      assert.equal(Number(sql(`SELECT score FROM player_scores WHERE player_id='${id}'`)), value);
    }
  });
  await check('06: worker metrics and outbox drained', async () => {
    await eventually(async () => {
      const m = await request('/metrics', 200, undefined, 'http://127.0.0.1:19100');
      for (const name of ['outbox_backlog', 'outbox_lag_seconds', 'worker_is_leader', 'worker_batches_total', 'worker_events_total', 'worker_applied_total', 'worker_errors_total', 'worker_rebuilds_total']) assert.match(m, new RegExp(`^${name} [-0-9.]+$`, 'm'));
      assert.match(m, /^outbox_backlog 0$/m); assert.match(m, /^worker_is_leader 1$/m);
    });
  });
  await check('07: worker stopped → queued scores → delivery after start', async () => {
    compose('stop', 'worker');
    try { await post('queued', 33); await request('/leaderboard/rank/queued', 404); assert.ok(Number(sql('SELECT count(*) FROM leaderboard_outbox')) > 0); }
    finally { compose('start', 'worker'); }
    await eventually(async () => assert.equal((await rank('queued')).player.score, 33));
  });
  await check('08: Redis outage, write availability and recovery', async () => {
    compose('stop', 'redis');
    try {
      await request('/health'); assert.deepEqual(await request('/ready', 503), { status: 'degraded', postgres: true, redis: false });
      for (const path of ['/leaderboard/top', '/leaderboard/rank/alice']) assert.equal((await request(path, 503)).error, 'leaderboard_unavailable');
      await post('redis-down', 44);
    } finally { compose('start', 'redis'); }
    await eventually(async () => assert.equal((await rank('redis-down')).player.score, 44));
    await eventually(() => request('/ready'));
  });
  await check('09: PostgreSQL outage, cached reads and process recovery', async () => {
    await request('/leaderboard/top'); compose('stop', 'postgres');
    try {
      await sleep(1100); await request('/health');
      assert.deepEqual(await request('/ready', 503), { status: 'degraded', postgres: false, redis: true });
      await request('/leaderboard/top'); assert.equal((await rank('alice')).player.score, 100);
      assert.equal((await post('pg-down', 1, 503)).error, 'storage_unavailable');
    } finally { compose('start', 'postgres'); }
    await eventually(() => request('/ready'));
    assert.equal((await post('pg-down', 1)).score, 1);
    await eventually(async () => assert.equal((await rank('pg-down')).player.score, 1));
  });
  await check('10: API/worker restarts retain leaderboard', async () => {
    await eventually(async () => assert.equal(Number(sql('SELECT count(*) FROM leaderboard_outbox')), 0));
    const snapshot = await request('/leaderboard/top');
    compose('restart', 'api', 'worker'); await eventually(() => request('/ready'));
    assert.deepEqual(await request('/leaderboard/top'), snapshot);
  });
  await check('11: Redis data loss triggers automatic rebuild', async () => {
    const current = await request('/leaderboard/top');
    const entries = JSON.parse(sql(`SELECT coalesce(json_agg(t), '[]') FROM (SELECT row_number() OVER (ORDER BY score DESC, tie_seq ASC)::int AS rank, player_id, score FROM player_scores WHERE season_id=${current.season_id} ORDER BY score DESC, tie_seq ASC LIMIT 100) t`));
    const snapshot = { season_id: current.season_id, entries };
    compose('exec', '-T', 'redis', 'redis-cli', 'FLUSHDB');
    await eventually(async () => assert.deepEqual(await request('/leaderboard/top'), snapshot));
  });
  await check('12: no active season, rollover and historical scores', async () => {
    const old = (await request('/leaderboard/top')).season_id;
    sql(`UPDATE seasons SET ends_at=now()-interval '1 second' WHERE id=${old}`);
    await sleep(1100);
    assert.equal((await post('no-season', 1, 503)).error, 'no_active_season');
    for (const path of ['/leaderboard/top', '/leaderboard/rank/alice']) assert.equal((await request(path, 503)).error, 'no_active_season');
    assert.equal(sql("SELECT count(*) FROM player_scores WHERE player_id='no-season'"), '0');
    sql("SELECT create_season(209912, now(), now()+interval '1 day')");
    await sleep(1100);
    assert.deepEqual(await request('/leaderboard/top'), { season_id: 209912, entries: [] });
    await request('/leaderboard/rank/alice', 404);
    assert.deepEqual(await post('alice', 3), { player_id: 'alice', season_id: 209912, score: 3 });
    await eventually(async () => assert.equal((await rank('alice')).player.score, 3));
    assert.equal(Number(sql(`SELECT score FROM player_scores WHERE season_id=${old} AND player_id='alice'`)), 100);
  });
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  writeFileSync('docs/smoke-results.json', JSON.stringify({ started, finished: new Date().toISOString(), base, results, requests }, null, 2) + '\n');
  console.log(`${results.filter(r => r.status === 'PASS').length}/${results.length} scenarios passed; ${requests.length} HTTP responses. Report: docs/smoke-results.json`);
}

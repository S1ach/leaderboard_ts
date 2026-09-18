import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keys } from '../src/lib/keys.js';
import { findStaleSeasons, processBatch } from '../src/lib/outbox.js';
import { rebuildSeason } from '../src/lib/rebuild.js';
import { createEnv, destroyEnv, drain, post, reset, TEST_SEASON, topIds, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => destroyEnv(env));
beforeEach(async () => reset(env));

const LB = keys.leaderboard(TEST_SEASON);
const META = keys.meta(TEST_SEASON);

async function randomWorkload(players = 50, events = 400) {
  for (let i = 0; i < events; i++) {
    const p = `p${Math.floor(Math.random() * players)}`;
    const d = Math.floor(Math.random() * 7) - 2 || 1;
    await post(env, p, d);
  }
}

describe('rebuild', () => {
  it('reproduces exactly the order produced by the worker', async () => {
    await randomWorkload();
    await drain(env, 37);
    const live = await env.redis.zrange(LB, 0, -1, 'WITHSCORES');
    expect(live.length).toBeGreaterThan(0);

    await env.redis.flushdb();
    const res = await rebuildSeason(env.worker, env.redis, TEST_SEASON, { readBatch: 7, zaddChunk: 3 });
    expect(res.skipped).toBe(false);
    expect(res.rows).toBe(live.length / 2);
    expect(await env.redis.zrange(LB, 0, -1, 'WITHSCORES')).toEqual(live);
    expect(await env.redis.exists(keys.rebuild(TEST_SEASON))).toBe(0);

    const st = await env.pool.query('SELECT last_batch FROM worker_state WHERE season_id = $1', [TEST_SEASON]);
    expect(st.rows[0].last_batch).toBe(res.w);
    expect(await env.redis.hget(META, 'batch')).toBe(String(res.w));
  });

  it('is skipped when the watermark is consistent, unless forced', async () => {
    await post(env, 'a', 1);
    await drain(env);
    expect((await rebuildSeason(env.worker, env.redis, TEST_SEASON)).skipped).toBe(true);
    expect((await rebuildSeason(env.worker, env.redis, TEST_SEASON, { force: true })).skipped).toBe(false);
  });

  it('detects a lost AOF tail (STALE) during apply and recovers by rebuilding', async () => {
    await post(env, 'a', 1);
    await post(env, 'b', 2);
    await drain(env);
    // Simulate the loss of the last batch: Redis "forgets" it.
    await env.redis.flushdb();
    await env.redis.hset(META, 'batch', '0');
    await post(env, 'c', 3);
    const r = await processBatch(env.worker, env.redis);
    expect(r).toEqual({ kind: 'inconsistent', code: 'STALE', seasonId: TEST_SEASON });
    await rebuildSeason(env.worker, env.redis, TEST_SEASON);
    await drain(env);
    expect(await topIds(env)).toEqual(['c', 'b', 'a']);
  });

  it('detects a wiped Redis (NOMETA) and the idle check finds the same', async () => {
    await post(env, 'a', 1);
    await drain(env);
    await env.redis.flushdb();
    expect(await findStaleSeasons(env.pool, env.redis)).toEqual([TEST_SEASON]);
    await post(env, 'b', 2);
    expect(await processBatch(env.worker, env.redis)).toEqual({ kind: 'inconsistent', code: 'NOMETA', seasonId: TEST_SEASON });
    await rebuildSeason(env.worker, env.redis, TEST_SEASON);
    expect(await findStaleSeasons(env.pool, env.redis)).toEqual([]);
    await drain(env);
    expect(await topIds(env)).toEqual(['b', 'a']);
  });

  it('a planned restart with an intact AOF does not trigger a rebuild', async () => {
    await post(env, 'a', 1);
    await drain(env);
    expect(await findStaleSeasons(env.pool, env.redis)).toEqual([]);
  });

  it('bypassing the outbox (seed) is covered after a forced rebuild, and seeded players keep updating', async () => {
    // Seed 3 players directly, advancing tie_seq past the seeded values (design.md §4.4 "Записи в обход outbox").
    const base: number = (await env.pool.query(`SELECT nextval('tie_seq') AS v`)).rows[0].v;
    await env.pool.query(
      `INSERT INTO player_scores (season_id, player_id, score, tie_seq) VALUES
       ($1, 's1', 100, $2), ($1, 's2', 100, $3), ($1, 's3', 50, $4)`,
      [TEST_SEASON, base + 1, base + 2, base + 3],
    );
    await env.pool.query(`SELECT setval('tie_seq', $1)`, [base + 3]);
    await rebuildSeason(env.worker, env.redis, TEST_SEASON, { force: true });
    expect(await topIds(env)).toEqual(['s1', 's2', 's3']);

    // A real update of a seeded player must not be rejected by the tie guard.
    await post(env, 's3', 50);
    await drain(env);
    expect(await topIds(env)).toEqual(['s1', 's2', 's3']);
    expect((await env.app.inject({ url: '/leaderboard/rank/s3' })).json().player.score).toBe(100);

    // And a wipe after the seed is now detected.
    await env.redis.flushdb();
    expect(await findStaleSeasons(env.pool, env.redis)).toEqual([TEST_SEASON]);
  });

  it('a failed pipeline command aborts the rebuild before the swap', async () => {
    await post(env, 'a', 1);
    await post(env, 'b', 2);
    await drain(env);
    await post(env, 'c', 3); // in PG only: a completed rebuild would add it to the key
    const lbBefore = await env.redis.zrange(LB, 0, -1, 'WITHSCORES');
    const metaBefore = await env.redis.hget(META, 'batch');
    const lastBatch = async () =>
      (await env.pool.query('SELECT last_batch FROM worker_state WHERE season_id = $1', [TEST_SEASON])).rows[0].last_batch;
    const lastBatchBefore = await lastBatch();

    // pipeline.exec() resolves even when a queued command fails: inject such a command.
    await env.redis.set('not-a-number', 'x');
    const faulty = new Proxy(env.redis, {
      get(target, prop, receiver) {
        if (prop !== 'pipeline') return Reflect.get(target, prop, receiver);
        return () => target.pipeline().incr('not-a-number');
      },
    });

    await expect(rebuildSeason(env.worker, faulty, TEST_SEASON, { force: true })).rejects.toThrow(/pipeline/);
    expect(await env.redis.zrange(LB, 0, -1, 'WITHSCORES')).toEqual(lbBefore);
    expect(await env.redis.hget(META, 'batch')).toBe(metaBefore);
    expect(await lastBatch()).toBe(lastBatchBefore);
    expect(await env.redis.exists(keys.rebuild(TEST_SEASON))).toBe(0); // temporary key cleaned up

    // The lock was released: a normal rebuild succeeds and picks up 'c'.
    await rebuildSeason(env.worker, env.redis, TEST_SEASON, { force: true });
    expect(await topIds(env)).toEqual(['c', 'b', 'a']);
  });

  it('blocks the worker while running and lets it drain afterwards', async () => {
    await post(env, 'a', 1);
    await drain(env);
    await env.worker.query('SELECT pg_advisory_lock($1)', [7_001_001]); // pretend a rebuild holds the lock
    const other = await (await import('../src/lib/db.js')).connectClient();
    try {
      await post(env, 'b', 2);
      expect((await processBatch(other, env.redis)).kind).toBe('locked');
      await env.worker.query('SELECT pg_advisory_unlock($1)', [7_001_001]);
      expect((await processBatch(other, env.redis)).kind).toBe('applied');
    } finally {
      await other.end();
    }
    expect(await topIds(env)).toEqual(['b', 'a']);
  });
});

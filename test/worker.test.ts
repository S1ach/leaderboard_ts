import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeScore } from '../src/lib/encoding.js';
import { keys } from '../src/lib/keys.js';
import { collapse, processBatch } from '../src/lib/outbox.js';
import { createRedis } from '../src/lib/redis.js';
import { createEnv, destroyEnv, drain, outboxCount, post, rank, reset, TEST_SEASON, topIds, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => destroyEnv(env));
beforeEach(async () => reset(env));

const LB = keys.leaderboard(TEST_SEASON);
const META = keys.meta(TEST_SEASON);

describe('apply script', () => {
  it('is idempotent: re-applying an event changes nothing', async () => {
    const args = ['p1', encodeScore(10, 7), 7];
    expect(await env.redis.lbApply(LB, META, 0, 1, ...args)).toBe(1);
    const before = await env.redis.zrange(LB, 0, -1, 'WITHSCORES');
    expect(await env.redis.lbApply(LB, META, 1, 2, ...args)).toBe(0);
    expect(await env.redis.zrange(LB, 0, -1, 'WITHSCORES')).toEqual(before);
  });

  it('never lets an older event overwrite a newer one', async () => {
    await env.redis.lbApply(LB, META, 0, 1, 'p1', encodeScore(20, 9), 9);
    expect(await env.redis.lbApply(LB, META, 1, 2, 'p1', encodeScore(10, 8), 8)).toBe(0);
    expect(Number(await env.redis.zscore(LB, 'p1'))).toBe(encodeScore(20, 9));
    // newer tie wins even with a lower score (negative delta)
    expect(await env.redis.lbApply(LB, META, 2, 3, 'p1', encodeScore(5, 10), 10)).toBe(1);
    expect(Number(await env.redis.zscore(LB, 'p1'))).toBe(encodeScore(5, 10));
  });

  it('keeps the guard correct for negative scores', async () => {
    await env.redis.lbApply(LB, META, 0, 1, 'p1', encodeScore(-3, 4), 4);
    expect(await env.redis.lbApply(LB, META, 1, 2, 'p1', encodeScore(-3, 3), 3)).toBe(0);
    expect(await env.redis.lbApply(LB, META, 2, 3, 'p1', encodeScore(-7, 5), 5)).toBe(1);
  });

  it('bootstraps meta for a fresh season only when expected = 0', async () => {
    await expect(env.redis.lbApply(LB, META, 5, 6, 'p1', encodeScore(1, 1), 1)).rejects.toThrow(/NOMETA/);
    expect(await env.redis.lbApply(LB, META, 0, 6, 'p1', encodeScore(1, 1), 1)).toBe(1);
    expect(await env.redis.hget(META, 'batch')).toBe('6');
  });

  it('reports STALE when meta is behind the committed watermark', async () => {
    await env.redis.lbApply(LB, META, 0, 3, 'p1', encodeScore(1, 1), 1);
    await expect(env.redis.lbApply(LB, META, 4, 5, 'p1', encodeScore(1, 2), 2)).rejects.toThrow(/STALE/);
    // meta only moves forward
    await env.redis.lbApply(LB, META, 3, 2, 'p2', encodeScore(1, 3), 3);
    expect(await env.redis.hget(META, 'batch')).toBe('3');
  });
});

describe('collapse', () => {
  it('keeps the newest event per player and season', () => {
    const m = collapse([
      { id: 1, season_id: 1, player_id: 'a', score: 1, tie_seq: 10 },
      { id: 2, season_id: 1, player_id: 'a', score: 3, tie_seq: 12 },
      { id: 3, season_id: 1, player_id: 'a', score: 2, tie_seq: 11 },
      { id: 4, season_id: 2, player_id: 'a', score: 9, tie_seq: 13 },
    ]);
    expect(m.get(1)!.get('a')!.score).toBe(3);
    expect(m.get(2)!.get('a')!.score).toBe(9);
  });
});

describe('outbox worker end to end', () => {
  it('delivers events, deletes them and advances the watermark', async () => {
    await post(env, 'a', 10);
    await post(env, 'b', 20);
    await post(env, 'a', 5);
    const [first] = await drain(env);
    expect(first.kind).toBe('applied');
    if (first.kind !== 'applied') return;
    expect(first.events).toBe(3);
    expect(first.applied).toBe(2); // collapsed per player
    expect(await outboxCount(env)).toBe(0);
    const st = await env.pool.query('SELECT last_batch FROM worker_state WHERE season_id = $1', [TEST_SEASON]);
    expect(st.rows[0].last_batch).toBe(first.batchId);
    expect(await env.redis.hget(META, 'batch')).toBe(String(first.batchId));
    expect(await topIds(env)).toEqual(['b', 'a']);
  });

  it('tie-break: earlier holder of the same score ranks higher; a later change drops the player among equals', async () => {
    await post(env, 'a', 10);
    await post(env, 'b', 10);
    await post(env, 'c', 5);
    await drain(env);
    expect(await topIds(env)).toEqual(['a', 'b', 'c']);

    await post(env, 'c', 5); // c reaches 10 last
    await drain(env);
    expect(await topIds(env)).toEqual(['a', 'b', 'c']);

    await post(env, 'a', -1);
    await post(env, 'a', 1); // a is back at 10 but got there last
    await drain(env);
    expect(await topIds(env)).toEqual(['b', 'c', 'a']);
  });

  it('applies events in batches with the watermark strictly increasing', async () => {
    for (let i = 0; i < 25; i++) await post(env, `p${i}`, i + 1);
    const results = await drain(env, 10);
    const ids = results.filter((r) => r.kind === 'applied').map((r) => (r as { batchId: number }).batchId);
    expect(ids.length).toBe(3);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect((await topIds(env, 3))).toEqual(['p24', 'p23', 'p22']);
  });

  it('keeps events in the outbox while Redis is unavailable and delivers them later', async () => {
    await post(env, 'a', 1);
    await post(env, 'b', 2);
    const dead = createRedis('redis://127.0.0.1:1/1', { lazyConnect: true });
    dead.on('error', () => {});
    await expect(processBatch(env.worker, dead)).rejects.toThrow();
    dead.disconnect();
    expect(await outboxCount(env)).toBe(2);
    // the failed attempt rolled back: no watermark moved
    const st = await env.pool.query('SELECT last_batch FROM worker_state WHERE season_id = $1', [TEST_SEASON]);
    expect(st.rows[0].last_batch).toBe(0);
    await drain(env);
    expect(await outboxCount(env)).toBe(0);
    expect(await topIds(env)).toEqual(['b', 'a']);
  });

  it('a crash between the Redis apply and the PG commit is harmless (meta ahead of last_batch)', async () => {
    await post(env, 'a', 1);
    // Simulate: Redis applied batch 99, PG never committed it.
    await env.redis.lbApply(LB, META, 0, 99, 'a', encodeScore(1, 1), 1);
    const [r] = await drain(env);
    expect(r.kind).toBe('applied');
    expect(Number(await env.redis.hget(META, 'batch'))).toBeGreaterThanOrEqual(99);
    expect((await rank(env, 'a')).body.player.score).toBe(1);
  });

  it('a new season bootstraps its meta without a rebuild', async () => {
    const NEXT = TEST_SEASON + 1;
    await env.pool.query(`UPDATE seasons SET ends_at = now() WHERE id = $1`, [TEST_SEASON]);
    await env.pool.query(`SELECT create_season($1, now(), now() + interval '1 hour')`, [NEXT]);
    const r = await post(env, 'z', 7);
    expect(r.body.season_id).toBe(NEXT);
    const [b] = await drain(env);
    expect(b.kind).toBe('applied');
    expect(await env.redis.hget(keys.meta(NEXT), 'batch')).not.toBeNull();
    expect(await env.redis.zrange(keys.leaderboard(NEXT), 0, -1)).toEqual(['z']);
  });
});

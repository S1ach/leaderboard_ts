import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, destroyEnv, drain, post, rank, reset, TEST_SEASON, top, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => destroyEnv(env));
beforeEach(async () => reset(env));

async function seed(n: number) {
  for (let i = 1; i <= n; i++) await post(env, `p${i}`, i * 10);
  await drain(env);
}

describe('GET /leaderboard/top', () => {
  it('returns ranked entries with decoded scores', async () => {
    await seed(5);
    const r = await top(env, 3);
    expect(r.status).toBe(200);
    expect(r.body.season_id).toBe(TEST_SEASON);
    expect(r.body.entries).toEqual([
      { rank: 1, player_id: 'p5', score: 50 },
      { rank: 2, player_id: 'p4', score: 40 },
      { rank: 3, player_id: 'p3', score: 30 },
    ]);
  });

  it('defaults to 100 and caps the limit', async () => {
    await seed(3);
    expect((await top(env)).body.entries.length).toBe(3);
    expect((await top(env, 5000)).status).toBe(400);
    expect((await top(env, 0)).status).toBe(400);
  });

  it('is empty for a fresh season', async () => {
    expect((await top(env)).body.entries).toEqual([]);
  });
});

describe('GET /leaderboard/rank/:player_id', () => {
  it('returns the player with n neighbours above and below', async () => {
    await seed(10);
    const r = await rank(env, 'p5', 2);
    expect(r.status).toBe(200);
    expect(r.body.player).toEqual({ rank: 6, player_id: 'p5', score: 50 });
    expect(r.body.above.map((e: { rank: number }) => e.rank)).toEqual([4, 5]);
    expect(r.body.below.map((e: { rank: number }) => e.rank)).toEqual([7, 8]);
    expect(r.body.above[0].player_id).toBe('p7');
    expect(r.body.below[1].player_id).toBe('p3');
  });

  it('clips neighbours at both ends of the table', async () => {
    await seed(3);
    const first = await rank(env, 'p3', 5);
    expect(first.body.player.rank).toBe(1);
    expect(first.body.above).toEqual([]);
    expect(first.body.below.length).toBe(2);
    const last = await rank(env, 'p1', 5);
    expect(last.body.player.rank).toBe(3);
    expect(last.body.above.length).toBe(2);
    expect(last.body.below).toEqual([]);
  });

  it('returns 404 for an unranked player and 400 for a bad n', async () => {
    await seed(1);
    expect((await rank(env, 'ghost')).status).toBe(404);
    expect((await rank(env, 'p1', 999)).status).toBe(400);
  });

  it('shows the lag between POST and read model until the worker runs', async () => {
    await post(env, 'late', 5);
    expect((await rank(env, 'late')).status).toBe(404);
    await drain(env);
    expect((await rank(env, 'late')).body.player.score).toBe(5);
  });
});

describe('GET /health', () => {
  it('is ok when both stores answer', async () => {
    const r = await env.app.inject({ url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', postgres: true, redis: true });
  });
});

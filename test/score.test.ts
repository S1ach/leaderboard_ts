import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, destroyEnv, outboxCount, post, reset, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => destroyEnv(env));
beforeEach(async () => reset(env));

describe('POST /score', () => {
  it('accumulates concurrent updates without lost updates (K parallel +1 → +K)', async () => {
    const K = 200;
    const results = await Promise.all(Array.from({ length: K }, () => post(env, 'alice', 1)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const row = await env.pool.query(`SELECT score FROM player_scores WHERE player_id = 'alice'`);
    expect(row.rows[0].score).toBe(K);
    expect(await outboxCount(env)).toBe(K);
    // The returned scores are exactly the set 1..K: every update saw the previous one.
    expect(new Set(results.map((r) => r.body.score)).size).toBe(K);
  });

  it('returns the new absolute score and writes absolute state to the outbox', async () => {
    expect((await post(env, 'bob', 10)).body.score).toBe(10);
    expect((await post(env, 'bob', 5)).body.score).toBe(15);
    const ob = await env.pool.query(`SELECT score, tie_seq FROM leaderboard_outbox ORDER BY id`);
    expect(ob.rows.map((r) => r.score)).toEqual([10, 15]);
    expect(ob.rows[0].tie_seq).toBeLessThan(ob.rows[1].tie_seq);
  });

  it('validates the body', async () => {
    expect((await post(env, '', 1)).status).toBe(400);
    expect((await post(env, 'x', 0)).status).toBe(400);
    expect((await post(env, 'x', 1.5)).status).toBe(400);
    expect((await post(env, 'x'.repeat(129), 1)).status).toBe(400);
    const missing = await env.app.inject({ method: 'POST', url: '/score', payload: { player_id: 'x' } });
    expect(missing.statusCode).toBe(400);
  });

  it('accepts negative deltas (assumption for open question 1)', async () => {
    await post(env, 'neg', 5);
    const r = await post(env, 'neg', -8);
    expect(r.status).toBe(200);
    expect(r.body.score).toBe(-3);
  });

  it('rejects a score outside the encoding range with 422 and rolls back', async () => {
    await post(env, 'big', 2_000_000);
    const r = await post(env, 'big', 100_000);
    expect(r.status).toBe(422);
    const row = await env.pool.query(`SELECT score FROM player_scores WHERE player_id = 'big'`);
    expect(row.rows[0].score).toBe(2_000_000);
    expect(await outboxCount(env)).toBe(1);
  });

  it('returns 503 when there is no active season', async () => {
    await env.pool.query(`UPDATE seasons SET starts_at = now() + interval '1 day', ends_at = now() + interval '2 day'`);
    const r = await post(env, 'x', 1);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('no_active_season');
  });
});

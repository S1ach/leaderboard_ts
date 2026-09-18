import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, destroyEnv, drain, post, rank, reset, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await createEnv();
});
afterAll(async () => destroyEnv(env));
beforeEach(async () => reset(env));

describe('concurrent scores keep PostgreSQL and the read model in step', () => {
  it('the outbox event with the highest tie_seq carries the final score', async () => {
    const K = 30;
    for (let round = 1; round <= 3; round++) {
      await reset(env);
      const player = `parallel-${round}`;
      await Promise.all(Array.from({ length: K }, () => post(env, player, 1)));

      const row = (await env.pool.query('SELECT score, tie_seq FROM player_scores WHERE player_id = $1', [player])).rows[0];
      expect(row.score).toBe(K);
      // The worker and the Lua guard treat the largest tie_seq as the newest state,
      // so it must belong to the event that carries the final score.
      const newest = (await env.pool.query('SELECT score, tie_seq FROM leaderboard_outbox ORDER BY tie_seq DESC LIMIT 1')).rows[0];
      expect({ round, score: newest.score, tie_seq: newest.tie_seq }).toEqual({ round, score: K, tie_seq: row.tie_seq });

      await drain(env);
      expect((await rank(env, player)).body.player.score).toBe(K);
    }
  });
});

import path from 'node:path';
import type pg from 'pg';
import { buildApp } from '../src/api/app.js';
import { connectClient, createPool } from '../src/lib/db.js';
import { runMigrations } from '../src/lib/migrate.js';
import { processBatch, type BatchResult } from '../src/lib/outbox.js';
import { createRedis, type RedisClient } from '../src/lib/redis.js';

export const TEST_SEASON = 209901;

export interface Env {
  pool: pg.Pool;
  worker: pg.Client; // dedicated connection, as in production
  redis: RedisClient;
  app: ReturnType<typeof buildApp>;
}

export async function createEnv(): Promise<Env> {
  const pool = createPool(undefined, 20);
  const migrator = await connectClient();
  await runMigrations(migrator, path.resolve('migrations'));
  await migrator.end();
  const worker = await connectClient();
  const redis = createRedis();
  const app = buildApp({ pg: pool, redis });
  await app.ready();
  return { pool, worker, redis, app };
}

export async function destroyEnv(env: Env): Promise<void> {
  await env.app.close();
  await env.worker.end();
  await env.pool.end();
  env.redis.disconnect();
}

/** Clean slate: one test season, active right now, empty leaderboard. */
export async function reset(env: Env, seasonId = TEST_SEASON): Promise<void> {
  await env.pool.query('TRUNCATE player_scores, leaderboard_outbox, worker_state, seasons');
  await env.pool.query(`SELECT create_season($1, now() - interval '1 hour', now() + interval '1 hour')`, [seasonId]);
  await env.redis.flushdb();
}

export async function post(env: Env, playerId: string, delta: number) {
  const res = await env.app.inject({ method: 'POST', url: '/score', payload: { player_id: playerId, score_delta: delta } });
  return { status: res.statusCode, body: res.json() };
}

export async function top(env: Env, limit?: number) {
  const res = await env.app.inject({ method: 'GET', url: '/leaderboard/top', query: limit !== undefined ? { limit: String(limit) } : {} });
  return { status: res.statusCode, body: res.json() };
}

export async function rank(env: Env, playerId: string, n?: number) {
  const res = await env.app.inject({
    method: 'GET',
    url: `/leaderboard/rank/${encodeURIComponent(playerId)}`,
    query: n !== undefined ? { n: String(n) } : {},
  });
  return { status: res.statusCode, body: res.json() };
}

/** Run the worker until the outbox is empty; returns all batch results. */
export async function drain(env: Env, batchSize = 500): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 0; i < 1000; i++) {
    const r = await processBatch(env.worker, env.redis, batchSize);
    results.push(r);
    if (r.kind === 'empty') return results;
    if (r.kind !== 'applied') throw new Error(`unexpected batch result: ${JSON.stringify(r)}`);
  }
  throw new Error('drain did not finish');
}

export async function outboxCount(env: Env): Promise<number> {
  return (await env.pool.query('SELECT count(*)::int AS c FROM leaderboard_outbox')).rows[0].c;
}

export async function topIds(env: Env, limit = 100): Promise<string[]> {
  return (await top(env, limit)).body.entries.map((e: { player_id: string }) => e.player_id);
}

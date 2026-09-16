import type pg from 'pg';
import { config, LOCKS } from './config.js';
import { encodeScore, tieLocal } from './encoding.js';
import { keys } from './keys.js';
import type { RedisClient } from './redis.js';
import { querySeason } from './season.js';

export interface RebuildResult {
  skipped: boolean;
  rows: number;
  w: number;
  durationMs: number;
}

export interface RebuildOptions {
  force?: boolean;
  readBatch?: number;
  zaddChunk?: number;
  log?: (msg: string) => void;
}

/**
 * RFC-001 §6 "Rebuild". `client` must be a dedicated connection that is not
 * inside a transaction: the exclusive advisory lock is session-level and the
 * final commit runs on the same session, so a dropped connection cannot leave
 * the worker running against a half-finished rebuild.
 */
export async function rebuildSeason(
  client: pg.Client,
  redis: RedisClient,
  seasonId: number,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const log = opts.log ?? (() => {});
  const readBatch = opts.readBatch ?? config.rebuildReadBatch;
  const zaddChunk = opts.zaddChunk ?? config.rebuildZaddChunk;
  const started = Date.now();

  const season = await querySeason(client, seasonId);
  if (!season) throw new Error(`unknown season ${seasonId}`);

  // 1. Exclusive lock: waits for the in-flight worker batch, blocks new ones.
  await client.query('SELECT pg_advisory_lock($1)', [LOCKS.REBUILD]);
  try {
    // 2. Re-check the invariant under the lock (avoids a double rebuild).
    if (!opts.force) {
      const st = await client.query('SELECT last_batch FROM worker_state WHERE season_id = $1', [seasonId]);
      const lastBatch: number = st.rows[0]?.last_batch ?? 0;
      const meta = await redis.hget(keys.meta(seasonId), 'batch');
      if (lastBatch > 0 && meta !== null && Number(meta) >= lastBatch) {
        log(`season ${seasonId}: meta.batch=${meta} >= last_batch=${lastBatch}, nothing to do`);
        return { skipped: true, rows: 0, w: 0, durationMs: Date.now() - started };
      }
    }

    // 3. Leftovers of a previous failed attempt.
    await redis.del(keys.rebuild(seasonId));

    // 4. The rebuild is "one more batch": it gets its own number W.
    await client.query('INSERT INTO worker_state (season_id) VALUES ($1) ON CONFLICT DO NOTHING', [seasonId]);
    const w: number = (await client.query(`SELECT nextval('outbox_batch_seq') AS w`)).rows[0].w;

    // 5–6. Stream the partition into the temporary key.
    let rows = 0;
    let lastId = '';
    let pipeline = redis.pipeline();
    let inPipeline = 0;
    for (;;) {
      const page = await client.query<{ player_id: string; score: number; tie_seq: number }>(
        `SELECT player_id, score, tie_seq FROM player_scores
          WHERE season_id = $1 AND player_id > $2
          ORDER BY player_id LIMIT $3`,
        [seasonId, lastId, readBatch],
      );
      if (page.rows.length === 0) break;
      for (let i = 0; i < page.rows.length; i += zaddChunk) {
        const chunk = page.rows.slice(i, i + zaddChunk);
        const args: (string | number)[] = [];
        for (const r of chunk) {
          args.push(encodeScore(r.score, tieLocal(r.tie_seq, season.tieBase)), r.player_id);
        }
        pipeline.zadd(keys.rebuild(seasonId), ...args);
        inPipeline++;
      }
      rows += page.rows.length;
      lastId = page.rows[page.rows.length - 1]!.player_id;
      if (inPipeline >= 8) {
        await pipeline.exec();
        pipeline = redis.pipeline();
        inPipeline = 0;
      }
      if (rows % 500_000 < readBatch) log(`season ${seasonId}: ${rows} rows loaded`);
    }
    if (inPipeline > 0) await pipeline.exec();

    // 7. Atomic swap + watermark.
    await redis.lbSwap(keys.leaderboard(seasonId), keys.meta(seasonId), keys.rebuild(seasonId), w);

    // 8. Commit the watermark in PG.
    await client.query('UPDATE worker_state SET last_batch = $1 WHERE season_id = $2', [w, seasonId]);

    const durationMs = Date.now() - started;
    log(`season ${seasonId}: rebuilt ${rows} rows as batch ${w} in ${durationMs} ms`);
    return { skipped: false, rows, w, durationMs };
  } finally {
    // 9. Release; the worker drains the backlog, older events are dropped by the tie guard.
    await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.REBUILD]).catch(() => {});
  }
}

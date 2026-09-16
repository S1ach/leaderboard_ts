import type pg from 'pg';
import { config, LOCKS } from './config.js';
import { encodeScore, tieLocal } from './encoding.js';
import { keys } from './keys.js';
import { isRedisScriptError, type RedisClient } from './redis.js';
import { querySeason } from './season.js';

export interface OutboxRow {
  id: number;
  season_id: number;
  player_id: string;
  score: number;
  tie_seq: number;
}

export type BatchResult =
  | { kind: 'locked' } // rebuild holds the exclusive lock
  | { kind: 'empty' }
  | { kind: 'applied'; batchId: number; events: number; applied: number; seasons: number[] }
  | { kind: 'inconsistent'; code: 'NOMETA' | 'STALE'; seasonId: number };

/** tie_base is immutable per season, so a process-wide cache is safe. */
const tieBaseCache = new Map<number, number>();

export async function getTieBase(db: pg.Client | pg.Pool, seasonId: number): Promise<number> {
  const cached = tieBaseCache.get(seasonId);
  if (cached !== undefined) return cached;
  const s = await querySeason(db, seasonId);
  if (!s) throw new Error(`unknown season ${seasonId}`);
  tieBaseCache.set(seasonId, s.tieBase);
  return s.tieBase;
}

/** Keep the newest event per (season, player). Events carry absolute state. */
export function collapse(rows: OutboxRow[]): Map<number, Map<string, OutboxRow>> {
  const bySeason = new Map<number, Map<string, OutboxRow>>();
  for (const row of rows) {
    let m = bySeason.get(row.season_id);
    if (!m) {
      m = new Map();
      bySeason.set(row.season_id, m);
    }
    const cur = m.get(row.player_id);
    if (!cur || cur.tie_seq < row.tie_seq) m.set(row.player_id, row);
  }
  return bySeason;
}

/**
 * One worker iteration (RFC-001 §5.5). `client` must be a dedicated
 * connection: the batch transaction, the shared rebuild lock and the leader
 * lock all live on the same session, so losing it loses everything at once.
 */
export async function processBatch(
  client: pg.Client,
  redis: RedisClient,
  batchSize = config.workerBatchSize,
): Promise<BatchResult> {
  await client.query('BEGIN');
  try {
    const lock = await client.query('SELECT pg_try_advisory_xact_lock_shared($1) AS ok', [LOCKS.REBUILD]);
    if (!lock.rows[0]?.ok) {
      await client.query('ROLLBACK');
      return { kind: 'locked' };
    }

    const sel = await client.query<OutboxRow>(
      `SELECT id, season_id, player_id, score, tie_seq
         FROM leaderboard_outbox
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (sel.rows.length === 0) {
      await client.query('ROLLBACK');
      return { kind: 'empty' };
    }

    const bySeason = collapse(sel.rows);
    const seasonIds = [...bySeason.keys()];

    const batchId: number = (await client.query(`SELECT nextval('outbox_batch_seq') AS id`)).rows[0].id;
    await client.query(
      `INSERT INTO worker_state (season_id) SELECT unnest($1::int[]) ON CONFLICT DO NOTHING`,
      [seasonIds],
    );
    const st = await client.query(
      `SELECT season_id, last_batch FROM worker_state WHERE season_id = ANY($1::int[]) FOR UPDATE`,
      [seasonIds],
    );
    const expected = new Map<number, number>(st.rows.map((r) => [r.season_id as number, r.last_batch as number]));

    let applied = 0;
    for (const [seasonId, players] of bySeason) {
      const tieBase = await getTieBase(client, seasonId);
      const args: (string | number)[] = [expected.get(seasonId) ?? 0, batchId];
      for (const ev of players.values()) {
        const tl = tieLocal(ev.tie_seq, tieBase);
        args.push(ev.player_id, encodeScore(ev.score, tl), tl);
      }
      try {
        applied += await redis.lbApply(keys.leaderboard(seasonId), keys.meta(seasonId), ...args);
      } catch (e) {
        if (isRedisScriptError(e, 'NOMETA') || isRedisScriptError(e, 'STALE')) {
          await client.query('ROLLBACK');
          return { kind: 'inconsistent', code: isRedisScriptError(e, 'NOMETA') ? 'NOMETA' : 'STALE', seasonId };
        }
        throw e;
      }
    }

    await client.query(`DELETE FROM leaderboard_outbox WHERE id = ANY($1::bigint[])`, [sel.rows.map((r) => r.id)]);
    await client.query(`UPDATE worker_state SET last_batch = $1 WHERE season_id = ANY($2::int[])`, [batchId, seasonIds]);
    await client.query('COMMIT');
    return { kind: 'applied', batchId, events: sel.rows.length, applied, seasons: seasonIds };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * Watermark check outside of batch processing (startup / idle): detects a
 * lost AOF tail even when no new events arrive. Returns seasons that need a
 * rebuild. Only current and future seasons are checked: keys of old seasons
 * are unlinked after the retention period on purpose.
 */
export async function findStaleSeasons(db: pg.Client | pg.Pool, redis: RedisClient): Promise<number[]> {
  const r = await db.query(
    `SELECT w.season_id, w.last_batch
       FROM worker_state w JOIN seasons s ON s.id = w.season_id
      WHERE w.last_batch > 0 AND s.ends_at > now()`,
  );
  const stale: number[] = [];
  for (const row of r.rows) {
    const meta = await redis.hget(keys.meta(row.season_id), 'batch');
    if (meta === null || Number(meta) < row.last_batch) stale.push(row.season_id);
  }
  return stale;
}

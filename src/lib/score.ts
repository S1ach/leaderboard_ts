import type { PgClient, PgPool } from './db.js';

/**
 * RFC-001 §4.4: one statement, one transaction, one round trip.
 * The season is resolved by the database clock; the outbox row carries the
 * absolute state so re-applying it is safe.
 */
const ADD_SCORE_SQL = `
WITH s AS (
  SELECT id FROM seasons
  WHERE starts_at <= now() AND now() < ends_at
),
upsert AS (
  INSERT INTO player_scores (season_id, player_id, score, tie_seq)
  SELECT s.id, $1, $2, nextval('tie_seq') FROM s
  ON CONFLICT (season_id, player_id) DO UPDATE
    SET score      = player_scores.score + EXCLUDED.score,
        tie_seq    = EXCLUDED.tie_seq,
        updated_at = now()
  RETURNING season_id, player_id, score, tie_seq
)
INSERT INTO leaderboard_outbox (season_id, player_id, score, tie_seq)
SELECT season_id, player_id, score, tie_seq FROM upsert
RETURNING season_id, score`;

export class NoActiveSeasonError extends Error {
  constructor() {
    super('no active season');
  }
}

export class ScoreOutOfRangeError extends Error {
  constructor() {
    super('resulting score is out of the supported range');
  }
}

export async function addScore(
  db: PgPool | PgClient,
  playerId: string,
  delta: number,
): Promise<{ seasonId: number; score: number }> {
  let r;
  try {
    r = await db.query(ADD_SCORE_SQL, [playerId, delta]);
  } catch (e) {
    if ((e as { code?: string }).code === '23514') throw new ScoreOutOfRangeError();
    throw e;
  }
  const row = r.rows[0];
  if (!row) throw new NoActiveSeasonError();
  return { seasonId: row.season_id, score: row.score };
}

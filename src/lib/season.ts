import type { PgClient, PgPool } from './db.js';
import { config } from './config.js';

export interface Season {
  id: number;
  tieBase: number;
  startsAt: Date;
  endsAt: Date;
}

const ACTIVE_SQL = `SELECT id, tie_base, starts_at, ends_at FROM seasons
                    WHERE starts_at <= now() AND now() < ends_at`;

export async function queryActiveSeason(db: PgPool | PgClient): Promise<Season | null> {
  const r = await db.query(ACTIVE_SQL);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, tieBase: row.tie_base, startsAt: row.starts_at, endsAt: row.ends_at };
}

export async function querySeason(db: PgPool | PgClient, id: number): Promise<Season | null> {
  const r = await db.query('SELECT id, tie_base, starts_at, ends_at FROM seasons WHERE id = $1', [id]);
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, tieBase: row.tie_base, startsAt: row.starts_at, endsAt: row.ends_at };
}

/**
 * Active season for reads (RFC-001 §4.4 "Чтения"): cached for a short TTL. At a season
 * boundary reads may lag by up to the TTL. A negative result is cached too.
 */
export class SeasonCache {
  private value: Season | null = null;
  private expiresAt = 0;
  private inflight: Promise<Season | null> | null = null;

  constructor(private readonly db: PgPool, private readonly ttlMs = config.seasonCacheTtlMs) {}

  get(): Promise<Season | null> {
    const now = Date.now();
    if (now < this.expiresAt) return Promise.resolve(this.value);
    if (this.inflight) return this.inflight;
    this.inflight = queryActiveSeason(this.db)
      .then((s) => {
        this.value = s;
        this.expiresAt = Date.now() + this.ttlMs;
        return s;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.expiresAt = 0;
  }
}

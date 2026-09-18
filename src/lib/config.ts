function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`env ${name} must be an integer, got "${v}"`);
  return n;
}

// Host ports the compose stack publishes; the same variables move the ports in
// docker-compose.yml, so one override is enough when 5433 or 6380 is taken.
const pgHostPort = int('POSTGRES_PORT', 5433);
const redisHostPort = int('REDIS_PORT', 6380);

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? `postgres://leaderboard:leaderboard@localhost:${pgHostPort}/leaderboard`,
  pgPoolSize: int('PG_POOL_SIZE', 10),
  redisUrl: process.env.REDIS_URL ?? `redis://localhost:${redisHostPort}/0`,
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  seasonCacheTtlMs: int('SEASON_CACHE_TTL_MS', 1000),
  topMaxLimit: int('TOP_MAX_LIMIT', 1000),
  rankMaxN: int('RANK_MAX_N', 50),
  playerIdMaxLen: int('PLAYER_ID_MAX_LEN', 128),

  workerBatchSize: int('WORKER_BATCH_SIZE', 500),
  workerPollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 50),
  workerIdleCheckIntervalMs: int('WORKER_IDLE_CHECK_INTERVAL_MS', 5000),
  workerMetricsPort: int('WORKER_METRICS_PORT', 9100),

  rebuildReadBatch: int('REBUILD_READ_BATCH', 20000),
  rebuildZaddChunk: int('REBUILD_ZADD_CHUNK', 5000),
};

/** Advisory lock keys (design.md §4.4). */
export const LOCKS = {
  /** Exclusive: rebuild. Shared: every worker batch transaction. */
  REBUILD: 7_001_001,
  /** Session-level leader lock: exactly one active worker. */
  WORKER_LEADER: 7_001_002,
} as const;

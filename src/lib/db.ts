import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// All bigint columns in this schema (score, tie_seq, batch ids) are far below
// 2^53, so parsing int8 as a JS number is exact.
pg.types.setTypeParser(20, (v) => Number(v));

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient | pg.Client;

export function createPool(connectionString = config.databaseUrl, max = config.pgPoolSize): pg.Pool {
  // Without a timeout a request waits forever for a connection while PostgreSQL is down.
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  // An idle client whose connection drops (e.g. a PostgreSQL restart) emits 'error' on the
  // pool; without a listener Node kills the process. The pool discards that client and
  // opens a new connection on the next query, so logging is enough.
  // Only message and code: pg attaches the whole client (with connection parameters) to the error.
  pool.on('error', (err) =>
    logger.warn({ error: err.message, code: (err as { code?: string }).code }, 'idle postgres connection lost'),
  );
  return pool;
}

/** Dedicated connection: used by the worker and rebuild so the advisory lock and the work share one session. */
export async function connectClient(connectionString = config.databaseUrl): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

import pg from 'pg';
import { config } from './config.js';

// All bigint columns in this schema (score, tie_seq, batch ids) are far below
// 2^53, so parsing int8 as a JS number is exact.
pg.types.setTypeParser(20, (v) => Number(v));

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient | pg.Client;

export function createPool(connectionString = config.databaseUrl, max = config.pgPoolSize): pg.Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}

/** Dedicated connection: used by the worker and rebuild so the advisory lock and the work share one session. */
export async function connectClient(connectionString = config.databaseUrl): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

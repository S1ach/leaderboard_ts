import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PgClient } from './db.js';

/** Minimal forward-only SQL migration runner; each file runs in one transaction. */
export async function runMigrations(client: PgClient, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Serialize concurrent migrators (e.g. several pods starting at once).
  await client.query('SELECT pg_advisory_lock(7001000)');
  const applied: string[] = [];
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      log(`applied ${f}`);
      applied.push(f);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7001000)');
  }
  return applied;
}

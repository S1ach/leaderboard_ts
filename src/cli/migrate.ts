import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectClient } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const client = await connectClient();
try {
  const applied = await runMigrations(client, dir, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema is up to date');
} finally {
  await client.end();
}

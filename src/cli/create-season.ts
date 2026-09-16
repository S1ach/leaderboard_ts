// Usage: npm run create-season -- 202610 [2026-10-01T00:00:00Z 2026-11-01T00:00:00Z]
import { connectClient } from '../lib/db.js';

const [idArg, startArg, endArg] = process.argv.slice(2);
if (!idArg || !/^\d{6}$/.test(idArg)) {
  console.error('usage: create-season <YYYYMM> [starts_at ends_at]');
  process.exit(1);
}
const id = Number(idArg);
const year = Math.floor(id / 100);
const month = id % 100;
const starts = startArg ? new Date(startArg) : new Date(Date.UTC(year, month - 1, 1));
const ends = endArg ? new Date(endArg) : new Date(Date.UTC(year, month, 1));

const client = await connectClient();
try {
  await client.query('SELECT create_season($1, $2, $3)', [id, starts, ends]);
  console.log(`season ${id}: ${starts.toISOString()} .. ${ends.toISOString()} created with its partition`);
} finally {
  await client.end();
}

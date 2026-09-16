// Usage: npm run rebuild-leaderboard -- [--season 202609] [--force]
import { connectClient } from '../lib/db.js';
import { rebuildSeason } from '../lib/rebuild.js';
import { createRedis } from '../lib/redis.js';
import { queryActiveSeason } from '../lib/season.js';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const si = argv.indexOf('--season');
const seasonArg = si >= 0 ? Number(argv[si + 1]) : undefined;

const client = await connectClient();
const redis = createRedis();
try {
  const seasonId = seasonArg ?? (await queryActiveSeason(client))?.id;
  if (!seasonId) throw new Error('no active season; pass --season <id>');
  const res = await rebuildSeason(client, redis, seasonId, { force, log: (m) => console.log(m) });
  console.log(JSON.stringify({ season: seasonId, ...res }));
} finally {
  await client.end();
  redis.disconnect();
}

// Usage: npm run seed -- --players 1000000 [--season 202609] [--max-score 100000]
// Bulk-loads players via COPY, bypassing the outbox. RFC-001 §5.5 "Записи в обход
// outbox": afterwards tie_seq is advanced past the seeded values and a forced
// rebuild is run so the watermark covers the seeded data.
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { from as copyFrom } from 'pg-copy-streams';
import { connectClient } from '../lib/db.js';
import { rebuildSeason } from '../lib/rebuild.js';
import { createRedis } from '../lib/redis.js';
import { queryActiveSeason, querySeason } from '../lib/season.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const players = Number(arg('--players') ?? 100_000);
const maxScore = Number(arg('--max-score') ?? 100_000);
const seasonArg = arg('--season');

const client = await connectClient();
const redis = createRedis();
try {
  const season = seasonArg ? await querySeason(client, Number(seasonArg)) : await queryActiveSeason(client);
  if (!season) throw new Error('season not found');
  const seasonId = season.id;

  const started = Date.now();
  await client.query('BEGIN');
  await client.query('DELETE FROM leaderboard_outbox WHERE season_id = $1', [season.id]);
  await client.query(`TRUNCATE player_scores_${season.id}`);

  // Reserve a contiguous block of tie_seq values for the seeded rows.
  const base: number = (await client.query(`SELECT nextval('tie_seq') AS v`)).rows[0].v;
  await client.query(`SELECT setval('tie_seq', $1)`, [base + players]);

  // Deterministic ids: p000000001 … ; scores use a skewed distribution so ties are common.
  function* rows() {
    let buf: string[] = [];
    for (let i = 1; i <= players; i++) {
      const score = Math.floor(Math.pow(Math.random(), 3) * maxScore);
      buf.push(`${seasonId}\tp${String(i).padStart(9, '0')}\t${score}\t${base + i}\n`);
      if (buf.length === 10_000) {
        yield buf.join('');
        buf = [];
      }
    }
    if (buf.length) yield buf.join('');
  }
  const copy = client.query(copyFrom(`COPY player_scores (season_id, player_id, score, tie_seq) FROM STDIN`));
  await pipeline(Readable.from(rows()), copy);
  await client.query('COMMIT');
  console.log(`seeded ${players} players into season ${season.id} in ${Date.now() - started} ms`);

  const res = await rebuildSeason(client, redis, season.id, { force: true, log: (m) => console.log(m) });
  console.log(JSON.stringify({ season: season.id, ...res }));
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await client.end();
  redis.disconnect();
}

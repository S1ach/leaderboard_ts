import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { PgPool } from '../lib/db.js';
import { config } from '../lib/config.js';
import { decodeScore, SCORE_ABS_LIMIT } from '../lib/encoding.js';
import { keys } from '../lib/keys.js';
import type { RedisClient } from '../lib/redis.js';
import { addScore, NoActiveSeasonError, ScoreOutOfRangeError } from '../lib/score.js';
import { SeasonCache, type Season } from '../lib/season.js';

export interface AppDeps {
  pg: PgPool;
  redis: RedisClient;
  seasonCache?: SeasonCache;
  logger?: boolean | object;
}

interface Entry {
  rank: number;
  player_id: string;
  score: number;
}

/** ZRANGE … WITHSCORES reply → entries with 1-based ranks starting at `firstRank`. */
function toEntries(flat: string[], firstRank: number): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({ rank: firstRank + i / 2, player_id: flat[i]!, score: decodeScore(Number(flat[i + 1])).score });
  }
  return out;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { pg, redis } = deps;
  const seasons = deps.seasonCache ?? new SeasonCache(pg);
  const app = Fastify({
    logger: deps.logger ?? false,
    // The router rejects a path parameter longer than this before schema validation
    // (414). It counts the URL-encoded length, where one character of player_id can
    // take up to 12 characters (%XX per UTF-8 byte), so the limit is well above
    // PLAYER_ID_MAX_LEN and the real limit is enforced by the schema, with 400.
    routerOptions: { maxParamLength: config.playerIdMaxLen * 12 },
  });

  /** Active season for reads, or null after replying 503 (no season, or PostgreSQL down with an empty cache). */
  async function activeSeason(req: FastifyRequest, reply: FastifyReply): Promise<Season | null> {
    try {
      const season = await seasons.get();
      if (!season) reply.code(503).send({ error: 'no_active_season' });
      return season;
    } catch (e) {
      req.log.error({ err: e }, 'active season lookup failed');
      reply.code(503).send({ error: 'storage_unavailable' });
      return null;
    }
  }

  // Liveness: the process is up and serving HTTP. It deliberately does not touch the
  // storages, otherwise an outage of PostgreSQL or Redis would make Kubernetes restart
  // every API pod, which cannot fix the storage and drops reads that still work.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: send traffic here only when both storages answer.
  app.get('/ready', async (_req, reply) => {
    const [pgOk, redisOk] = await Promise.all([
      pg.query('SELECT 1').then(() => true, () => false),
      redis.ping().then(() => true, () => false),
    ]);
    const ok = pgOk && redisOk;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', postgres: pgOk, redis: redisOk });
  });

  app.post<{ Body: { player_id: string; score_delta: number } }>(
    '/score',
    {
      schema: {
        body: {
          type: 'object',
          required: ['player_id', 'score_delta'],
          properties: {
            player_id: { type: 'string', minLength: 1, maxLength: config.playerIdMaxLen },
            // Zero is rejected: a no-op update would still move the player among equals (§4.4).
            score_delta: {
              type: 'integer',
              minimum: -(SCORE_ABS_LIMIT - 1),
              maximum: SCORE_ABS_LIMIT - 1,
              not: { const: 0 },
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const r = await addScore(pg, req.body.player_id, req.body.score_delta);
        // Minimal audit trail (RFC-001 §7): who got how much, and the resulting score.
        req.log.info(
          { player_id: req.body.player_id, score_delta: req.body.score_delta, score: r.score, season_id: r.seasonId },
          'score added',
        );
        return { player_id: req.body.player_id, season_id: r.seasonId, score: r.score };
      } catch (e) {
        if (e instanceof NoActiveSeasonError) return reply.code(503).send({ error: 'no_active_season' });
        if (e instanceof ScoreOutOfRangeError) return reply.code(422).send({ error: 'score_out_of_range' });
        req.log.error({ err: e }, 'POST /score failed');
        return reply.code(503).send({ error: 'storage_unavailable' });
      }
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/leaderboard/top',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: config.topMaxLimit, default: 100 } },
        },
      },
    },
    async (req, reply) => {
      const season = await activeSeason(req, reply);
      if (!season) return reply;
      const limit = req.query.limit ?? 100;
      let flat: string[];
      try {
        flat = await redis.zrange(keys.leaderboard(season.id), 0, limit - 1, 'REV', 'WITHSCORES');
      } catch (e) {
        req.log.error({ err: e }, 'redis read failed');
        return reply.code(503).send({ error: 'leaderboard_unavailable' });
      }
      return { season_id: season.id, entries: toEntries(flat, 1) };
    },
  );

  app.get<{ Params: { player_id: string }; Querystring: { n?: number } }>(
    '/leaderboard/rank/:player_id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { player_id: { type: 'string', minLength: 1, maxLength: config.playerIdMaxLen } },
        },
        querystring: {
          type: 'object',
          properties: { n: { type: 'integer', minimum: 0, maximum: config.rankMaxN, default: 5 } },
        },
      },
    },
    async (req, reply) => {
      const season = await activeSeason(req, reply);
      if (!season) return reply;
      const n = req.query.n ?? 5;
      let res: [number, number, string[]] | null;
      try {
        res = await redis.lbRank(keys.leaderboard(season.id), req.params.player_id, n);
      } catch (e) {
        req.log.error({ err: e }, 'redis read failed');
        return reply.code(503).send({ error: 'leaderboard_unavailable' });
      }
      if (!res) return reply.code(404).send({ error: 'player_not_ranked' });
      const [r, from, flat] = res;
      const entries = toEntries(flat, from + 1);
      const idx = r - from;
      return {
        season_id: season.id,
        player: entries[idx],
        above: entries.slice(0, idx),
        below: entries.slice(idx + 1),
      };
    },
  );

  return app;
}

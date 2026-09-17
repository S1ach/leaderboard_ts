import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Outbox apply (RFC-001 §4.4).
 * KEYS[1] = leaderboard:{S}, KEYS[2] = leaderboard:{S}:meta
 * ARGV[1] = expected (worker_state.last_batch), ARGV[2] = batch_id,
 * then triples: member, redis_score, tie_local.
 */
export const APPLY_LUA = `
local last = redis.call('HGET', KEYS[2], 'batch')
if not last then
  if tonumber(ARGV[1]) ~= 0 then
    return redis.error_reply('NOMETA')
  end
  last = '0'
end
if tonumber(last) < tonumber(ARGV[1]) then
  return redis.error_reply('STALE')
end
local applied = 0
for i = 3, #ARGV, 3 do
  local cur = redis.call('ZSCORE', KEYS[1], ARGV[i])
  local newer = true
  if cur then
    local cur_tie = 4294967295 - (tonumber(cur) % 4294967296)
    newer = cur_tie < tonumber(ARGV[i + 2])
  end
  if newer then
    redis.call('ZADD', KEYS[1], ARGV[i + 1], ARGV[i])
    applied = applied + 1
  end
end
if tonumber(ARGV[2]) > tonumber(last) then
  redis.call('HSET', KEYS[2], 'batch', ARGV[2])
end
return applied
`;

/**
 * Rebuild swap (RFC-001 §4.4, rebuild step 6). One script so RENAME and HSET are atomic
 * even under AOF truncation.
 * KEYS[1] = leaderboard, KEYS[2] = meta, KEYS[3] = rebuild; ARGV[1] = W
 */
export const SWAP_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  redis.call('RENAME', KEYS[3], KEYS[1])
else
  redis.call('DEL', KEYS[1])
end
redis.call('HSET', KEYS[2], 'batch', ARGV[1])
return 1
`;

/**
 * Rank with neighbours from a single snapshot (RFC-001 §2.2).
 * KEYS[1] = leaderboard; ARGV[1] = member, ARGV[2] = n
 */
export const RANK_LUA = `
local r = redis.call('ZREVRANK', KEYS[1], ARGV[1])
if not r then return false end
local n = tonumber(ARGV[2])
local from = math.max(0, r - n)
return { r, from, redis.call('ZRANGE', KEYS[1], from, r + n, 'REV', 'WITHSCORES') }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    lbApply(lbKey: string, metaKey: string, ...args: (string | number)[]): Promise<number>;
    lbSwap(lbKey: string, metaKey: string, rebuildKey: string, w: number): Promise<number>;
    lbRank(lbKey: string, member: string, n: number): Promise<[number, number, string[]] | null>;
  }
}

export type RedisClient = Redis;

export function createRedis(url = config.redisUrl, opts: { lazyConnect?: boolean } = {}): Redis {
  const redis = new Redis(url, {
    lazyConnect: opts.lazyConnect ?? false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 5000,
  });
  // ioredis reconnects on its own (default retryStrategy); the listener only turns
  // connection errors into log lines instead of "[ioredis] Unhandled error event".
  redis.on('error', (err) => logger.warn({ error: err.message }, 'redis connection error'));
  redis.defineCommand('lbApply', { numberOfKeys: 2, lua: APPLY_LUA });
  redis.defineCommand('lbSwap', { numberOfKeys: 3, lua: SWAP_LUA });
  redis.defineCommand('lbRank', { numberOfKeys: 1, lua: RANK_LUA });
  return redis;
}

export function isRedisScriptError(err: unknown, code: 'NOMETA' | 'STALE'): boolean {
  return err instanceof Error && err.message.includes(code);
}

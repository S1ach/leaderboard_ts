import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from '../src/api/app.js';
import { createPool } from '../src/lib/db.js';
import { SeasonCache } from '../src/lib/season.js';
import { createEnv, destroyEnv, drain, post, reset, TEST_SEASON, type Env } from './helpers.js';

/**
 * TCP proxy in front of PostgreSQL. stop() closes the listener and drops every
 * open connection: for the API this looks exactly like a PostgreSQL restart.
 */
class TcpProxy {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  port = 0;

  constructor(private readonly targetHost: string, private readonly targetPort: number) {}

  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => {});
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

let env: Env;
let proxy: TcpProxy;
let proxiedUrl: string;

beforeAll(async () => {
  env = await createEnv();
  const target = new URL(process.env.DATABASE_URL!);
  proxy = new TcpProxy(target.hostname, Number(target.port));
  await proxy.start();
  target.hostname = '127.0.0.1';
  target.port = String(proxy.port);
  proxiedUrl = target.toString();
});
afterAll(async () => {
  await proxy.stop().catch(() => {});
  await destroyEnv(env);
});
beforeEach(async () => reset(env));

describe('PostgreSQL outage', () => {
  it('reads keep answering from Redis, writes fail with 503 and recover without a restart', async () => {
    await post(env, 'a', 20);
    await post(env, 'b', 10);
    await drain(env);

    const pool = createPool(proxiedUrl, 2);
    const app = buildApp({ pg: pool, redis: env.redis, seasonCache: new SeasonCache(pool, 50) });
    try {
      const write = (id: string) =>
        app.inject({ method: 'POST', url: '/score', payload: { player_id: id, score_delta: 1 } });

      // Warm up: the season is cached and the pool holds idle connections.
      expect((await write('c')).statusCode).toBe(200);
      expect((await app.inject({ url: '/leaderboard/top' })).statusCode).toBe(200);

      await proxy.stop(); // idle pool clients are terminated, as on a PG restart
      await sleep(100); // season cache TTL (50 ms) has expired

      const topRes = await app.inject({ url: '/leaderboard/top' });
      expect(topRes.statusCode).toBe(200);
      expect(topRes.json().season_id).toBe(TEST_SEASON);
      expect(topRes.json().entries.map((e: { player_id: string }) => e.player_id)).toEqual(['a', 'b']);
      const rankRes = await app.inject({ url: '/leaderboard/rank/b?n=1' });
      expect(rankRes.statusCode).toBe(200);
      expect(rankRes.json().player.rank).toBe(2);

      expect((await app.inject({ url: '/health' })).statusCode).toBe(200); // liveness: do not restart
      const ready = await app.inject({ url: '/ready' });
      expect(ready.statusCode).toBe(503); // readiness: take out of rotation
      expect(ready.json()).toEqual({ status: 'degraded', postgres: false, redis: true });

      const failed = await write('d');
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error).toBe('storage_unavailable');

      await proxy.start(); // same port: PostgreSQL is back
      const recovered = await write('d');
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().score).toBe(1);
      expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
    } finally {
      await app.close();
      await pool.end();
      if (!proxy['server']?.listening) await proxy.start();
    }
  });

  it('answers 503, not 500, when no season has ever been loaded', async () => {
    await proxy.stop();
    const pool = createPool(proxiedUrl, 1);
    const app = buildApp({ pg: pool, redis: env.redis, seasonCache: new SeasonCache(pool, 50) });
    try {
      for (const url of ['/leaderboard/top', '/leaderboard/rank/a']) {
        const res = await app.inject({ url });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('storage_unavailable');
      }
    } finally {
      await app.close();
      await pool.end();
      await proxy.start();
    }
  });
});

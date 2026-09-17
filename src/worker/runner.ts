import http from 'node:http';
import type pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, LOCKS } from '../lib/config.js';
import { connectClient, createPool } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { findStaleSeasons, processBatch } from '../lib/outbox.js';
import { rebuildSeason } from '../lib/rebuild.js';
import { createRedis, type RedisClient } from '../lib/redis.js';

export interface WorkerStats {
  isLeader: number;
  batches: number;
  events: number;
  applied: number;
  redisErrors: number;
  rebuilds: number;
  lastBatchAt: number;
}

export class Worker {
  private stopped = false;
  private client!: pg.Client;
  private redis!: RedisClient;
  readonly stats: WorkerStats = { isLeader: 0, batches: 0, events: 0, applied: 0, redisErrors: 0, rebuilds: 0, lastBatchAt: 0 };

  async run(): Promise<void> {
    this.client = await connectClient();
    this.redis = createRedis();
    // Connection loss = loss of the leader lock and any in-flight batch: exit and let the orchestrator restart us.
    this.client.on('error', (err) => {
      logger.fatal({ err }, 'postgres connection lost, exiting');
      process.exit(2);
    });

    await this.becomeLeader();
    await this.checkInvariant();

    let backoff = 100;
    let lastIdleCheck = Date.now();
    let waitingForRebuild = false;
    while (!this.stopped) {
      try {
        const r = await processBatch(this.client, this.redis);
        backoff = 100;
        if (waitingForRebuild && r.kind !== 'locked') {
          waitingForRebuild = false;
          logger.info('rebuild finished, resuming');
        }
        switch (r.kind) {
          case 'applied':
            this.stats.batches++;
            this.stats.events += r.events;
            this.stats.applied += r.applied;
            this.stats.lastBatchAt = Date.now();
            logger.debug({ batch: r.batchId, events: r.events, applied: r.applied }, 'batch applied');
            if (r.events < config.workerBatchSize) await sleep(config.workerPollIntervalMs);
            break;
          case 'empty':
            if (Date.now() - lastIdleCheck > config.workerIdleCheckIntervalMs) {
              await this.checkInvariant();
              lastIdleCheck = Date.now();
            }
            await sleep(config.workerPollIntervalMs);
            break;
          case 'locked':
            if (!waitingForRebuild) logger.info('rebuild in progress, waiting');
            waitingForRebuild = true;
            await sleep(250);
            continue;
          case 'inconsistent':
            logger.warn({ season: r.seasonId, code: r.code }, 'read model inconsistent, rebuilding');
            await this.rebuild(r.seasonId);
            break;
        }
      } catch (err) {
        this.stats.redisErrors++;
        logger.error({ err, backoff }, 'batch failed, retrying');
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  }

  private async becomeLeader(): Promise<void> {
    for (;;) {
      const r = await this.client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCKS.WORKER_LEADER]);
      if (r.rows[0]?.ok) break;
      logger.info('another worker is the leader, standing by');
      await sleep(1000);
    }
    this.stats.isLeader = 1;
    logger.info('became leader');
  }

  private async checkInvariant(): Promise<void> {
    const stale = await findStaleSeasons(this.client, this.redis);
    for (const seasonId of stale) {
      logger.warn({ season: seasonId }, 'watermark check failed, rebuilding');
      await this.rebuild(seasonId);
    }
  }

  private async rebuild(seasonId: number): Promise<void> {
    this.stats.rebuilds++;
    const res = await rebuildSeason(this.client, this.redis, seasonId, { log: (m) => logger.info(m) });
    logger.info({ season: seasonId, ...res }, 'rebuild finished');
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Prometheus-style text metrics (RFC-001 §3.4). Uses its own tiny pool: the worker connection is busy. */
export function startMetricsServer(worker: Worker, port: number): http.Server {
  const pool = createPool(config.databaseUrl, 1);
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    let backlog = -1;
    let lag = 0;
    try {
      const r = await pool.query(
        `SELECT count(*)::int AS backlog, coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS lag FROM leaderboard_outbox`,
      );
      backlog = r.rows[0].backlog;
      lag = r.rows[0].lag;
    } catch {
      /* report -1 */
    }
    const s = worker.stats;
    const body = [
      '# TYPE outbox_backlog gauge',
      `outbox_backlog ${backlog}`,
      '# TYPE outbox_lag_seconds gauge',
      `outbox_lag_seconds ${lag}`,
      '# TYPE worker_is_leader gauge',
      `worker_is_leader ${s.isLeader}`,
      '# TYPE worker_batches_total counter',
      `worker_batches_total ${s.batches}`,
      '# TYPE worker_events_total counter',
      `worker_events_total ${s.events}`,
      '# TYPE worker_applied_total counter',
      `worker_applied_total ${s.applied}`,
      '# TYPE worker_errors_total counter',
      `worker_errors_total ${s.redisErrors}`,
      '# TYPE worker_rebuilds_total counter',
      `worker_rebuilds_total ${s.rebuilds}`,
      '',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body);
  });
  server.listen(port);
  return server;
}

import { buildApp } from './api/app.js';
import { config } from './lib/config.js';
import { createPool } from './lib/db.js';
import { logger } from './lib/logger.js';
import { createRedis } from './lib/redis.js';

const pg = createPool();
const redis = createRedis();
const app = buildApp({ pg, redis, logger: { level: config.logLevel } });

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await pg.end();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.listen({ port: config.port, host: config.host }).catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

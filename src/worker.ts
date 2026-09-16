import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { startMetricsServer, Worker } from './worker/runner.js';

const worker = new Worker();
const metrics = startMetricsServer(worker, config.workerMetricsPort);

function shutdown(signal: string) {
  logger.info({ signal }, 'stopping worker');
  worker.stop();
  metrics.close();
  // Give the in-flight batch a moment to finish, then exit; an unfinished batch simply rolls back.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

worker.run().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});

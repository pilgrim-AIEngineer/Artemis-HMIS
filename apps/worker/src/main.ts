import { createDb, resolveAppDatabaseUrl, resolveDatabaseUrl } from '@hmis/db';
import { createLogger } from '@hmis/shared/logger';
import { createBoss, registerJobs } from './boss';
import { filesDirFromEnv } from './files';
import { QUEUE_END_OF_DAY, QUEUE_END_OF_DAY_CRON } from './jobs/queue-end-of-day';

const logger = createLogger('hmis-worker');
const boss = createBoss(resolveDatabaseUrl());
// Business queries run as the least-privileged app role, like the web app (no DELETE, append-only logs).
const db = createDb({
  connectionString: resolveAppDatabaseUrl(),
  applicationName: 'hmis-worker',
  max: 4,
});

// pg-boss reports connection blips here; it retries on its own (never block on the network).
boss.on('error', (err) =>
  logger.error({ err: { name: err.name, message: err.message } }, 'pg-boss error'),
);

await boss.start();
await registerJobs(boss, { logger, db, filesDir: filesDirFromEnv() });
await boss.schedule(QUEUE_END_OF_DAY, QUEUE_END_OF_DAY_CRON, {}, { tz: 'Asia/Kolkata' });
logger.info('worker started');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping');
    boss
      .stop({ graceful: true, timeout: 20_000 })
      .then(() => db.$client.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'worker stop failed');
        process.exit(1);
      });
  });
}

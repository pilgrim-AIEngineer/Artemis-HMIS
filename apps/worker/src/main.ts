import { resolveDatabaseUrl } from '@hmis/db';
import { createLogger } from '@hmis/shared/logger';
import { createBoss, registerJobs } from './boss';

const logger = createLogger('hmis-worker');
const boss = createBoss(resolveDatabaseUrl());

// pg-boss reports connection blips here; it retries on its own (never block on the network).
boss.on('error', (err) =>
  logger.error({ err: { name: err.name, message: err.message } }, 'pg-boss error'),
);

await boss.start();
await registerJobs(boss, logger);
logger.info('worker started');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping');
    boss
      .stop({ graceful: true, timeout: 20_000 })
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'worker stop failed');
        process.exit(1);
      });
  });
}

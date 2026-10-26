import { createDb, resolveAppDatabaseUrl, resolveDatabaseUrl } from '@hmis/db';
import { createLogger } from '@hmis/shared/logger';
import { createBoss, registerJobs } from './boss';
import { filesDirFromEnv } from './files';
import { OPS_BACKUP_CHECK_CRON, OPS_BACKUP_CHECK_QUEUE } from './jobs/ops-backup-check';
import { OPS_HEALTH_PING_CRON, OPS_HEALTH_PING_QUEUE } from './jobs/ops-health-ping';
import { OUTBOX_WHATSAPP_CRON, OUTBOX_WHATSAPP_QUEUE } from './jobs/outbox-whatsapp';
import { QUEUE_END_OF_DAY, QUEUE_END_OF_DAY_CRON } from './jobs/queue-end-of-day';
import { REMINDER_DAILY_CRON, REMINDER_DAILY_QUEUE } from './jobs/reminder-daily';

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
await boss.schedule(OUTBOX_WHATSAPP_QUEUE, OUTBOX_WHATSAPP_CRON, {}, { tz: 'Asia/Kolkata' });
await boss.schedule(REMINDER_DAILY_QUEUE, REMINDER_DAILY_CRON, {}, { tz: 'Asia/Kolkata' });
await boss.schedule(OPS_BACKUP_CHECK_QUEUE, OPS_BACKUP_CHECK_CRON, {}, { tz: 'Asia/Kolkata' });
await boss.schedule(OPS_HEALTH_PING_QUEUE, OPS_HEALTH_PING_CRON, {}, { tz: 'Asia/Kolkata' });
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

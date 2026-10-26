import { isBackupAlert } from '@hmis/shared';
import { collectOpsChecks } from '@hmis/shared/ops-node';
import { z } from 'zod';
import { AlertThrottle, alertSinksFromEnv, dispatchAlerts } from '../ops/alerts';
import { defineJob } from './types';

export const OPS_BACKUP_CHECK_QUEUE = 'ops.backupCheck';
/** Hourly at :05 (docs/01 §2). */
export const OPS_BACKUP_CHECK_CRON = '5 * * * *';

const sinks = alertSinksFromEnv(process.env);
const throttle = new AlertThrottle(sinks.repeatMs);

/**
 * Reads the backup container's status file and alerts the vendor when a backup is older than
 * 24 h, the cloud copy lags more than 48 h or the USB disk was not swapped for 8 days (docs/31 §3, §5).
 * Disk and outbox alerts belong to `ops.healthPing`.
 */
export const opsBackupCheckJob = defineJob({
  name: OPS_BACKUP_CHECK_QUEUE,
  schema: z.object({}).strict(),
  async handle(_data, { logger }) {
    const now = new Date();
    // The queue check is not needed here; skip the database.
    const checks = await collectOpsChecks({
      env: process.env,
      now,
      queue: () => Promise.resolve(null),
    });
    const alerts = checks.alerts.filter(isBackupAlert);
    const sent = await dispatchAlerts({ active: alerts, throttle, sinks, logger, now });
    logger.info(
      { state: checks.backup.state, open: alerts.length, sent: sent.length },
      'backup check done',
    );
    return { state: checks.backup.state, alerts: alerts.map((a) => a.code) };
  },
});

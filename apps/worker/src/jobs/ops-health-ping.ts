import { checkDbHealth, getOutboxLag } from '@hmis/db';
import { isBackupAlert, type OpsAlert } from '@hmis/shared';
import { collectOpsChecks } from '@hmis/shared/ops-node';
import { z } from 'zod';
import { AlertThrottle, alertSinksFromEnv, dispatchAlerts } from '../ops/alerts';
import { buildHeartbeatPayload, installIdFromEnv } from '../ops/heartbeat-payload';
import { defineJob } from './types';

export const OPS_HEALTH_PING_QUEUE = 'ops.healthPing';
/** Every 5 minutes (docs/01 §2). */
export const OPS_HEALTH_PING_CRON = '*/5 * * * *';

const sinks = alertSinksFromEnv(process.env);
const throttle = new AlertThrottle(sinks.repeatMs);
const PING_TIMEOUT_MS = 10_000;

/**
 * Pings a healthchecks.io-style URL (`HEALTHCHECK_PING_URL`) so the vendor notices a dead server
 * or a dead worker, and appends `/fail` while a critical alert is open. Offline is normal: a
 * failed ping is logged and forgotten (never retried in a loop, never blocks anything).
 */
export const opsHealthPingJob = defineJob({
  name: OPS_HEALTH_PING_QUEUE,
  schema: z.object({}).strict(),
  async handle(_data, { db, logger }) {
    const now = new Date();
    const dbCheck = await checkDbHealth(db);
    const checks = await collectOpsChecks({
      env: process.env,
      now,
      queue: () => (dbCheck.ok ? getOutboxLag(db, now) : Promise.resolve(null)),
    });
    const alerts: OpsAlert[] = [
      ...(dbCheck.ok
        ? []
        : [
            {
              code: 'db.down' as const,
              severity: 'critical' as const,
              message: 'The database is not answering.',
            },
          ]),
      ...checks.alerts,
    ];
    // Backup alerts are sent by ops.backupCheck; they still turn the ping red below.
    await dispatchAlerts({
      active: alerts.filter((a) => !isBackupAlert(a)),
      throttle,
      sinks,
      logger,
      now,
    });

    const base = process.env.HEALTHCHECK_PING_URL?.trim();
    let pinged = false;
    if (base) {
      const critical = alerts.filter((a) => a.severity === 'critical');
      const url = critical.length > 0 ? `${base.replace(/\/+$/, '')}/fail` : base;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Allow-listed counts and codes plus a random install ID; never the hospital label.
          body: JSON.stringify(
            buildHeartbeatPayload({
              installId: installIdFromEnv(process.env),
              now,
              alerts,
              checks,
            }),
          ),
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        pinged = res.ok;
      } catch {
        // offline: expected sometimes
      }
      if (!pinged) logger.warn('health ping failed (offline or monitor down)');
    }
    return { pinged, alerts: alerts.map((a) => a.code) };
  },
});

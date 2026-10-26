import 'server-only';
import { checkDbHealth, getOutboxLag, type Db } from '@hmis/db';
import type { HealthStatus } from '@hmis/shared';
import { collectOpsChecks } from '@hmis/shared/ops-node';
import { getDb } from './db';

export const APP_VERSION = process.env.HMIS_VERSION ?? 'dev';

/**
 * Liveness + DB connectivity (docs/01 §8) plus disk free, last backup age and outbox lag
 * (OPS-01). Only a dead database makes `status` degraded; everything else is an `alert`.
 */
export async function getHealth(db: () => Db = getDb): Promise<HealthStatus> {
  let dbCheck: HealthStatus['checks']['db'];
  let queue: () => Promise<{ backlog: number; oldestAgeSeconds: number | null } | null> = () =>
    Promise.resolve(null);
  try {
    const handle = db();
    dbCheck = await checkDbHealth(handle);
    if (dbCheck.ok) queue = () => getOutboxLag(handle);
  } catch {
    // Not configured: reported as down, details stay in server config.
    dbCheck = { ok: false, latencyMs: null };
  }
  const now = new Date();
  const ops = await collectOpsChecks({ env: process.env, now, queue });
  const alerts = dbCheck.ok
    ? ops.alerts
    : [
        {
          code: 'db.down' as const,
          severity: 'critical' as const,
          message: 'The database is not answering.',
        },
        ...ops.alerts,
      ];
  return {
    status: dbCheck.ok ? 'ok' : 'degraded',
    version: APP_VERSION,
    time: now.toISOString(),
    checks: { db: dbCheck, disk: ops.disk, backup: ops.backup, queue: ops.queue },
    alerts,
  };
}

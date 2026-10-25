import 'server-only';
import { checkDbHealth, type Db } from '@hmis/db';
import type { HealthStatus } from '@hmis/shared';
import { getDb } from './db';

export const APP_VERSION = process.env.HMIS_VERSION ?? 'dev';

/** Liveness + DB connectivity (docs/01 §8). Disk, backup age and queue lag come with OPS-01. */
export async function getHealth(db: () => Db = getDb): Promise<HealthStatus> {
  let dbCheck: HealthStatus['checks']['db'];
  try {
    dbCheck = await checkDbHealth(db());
  } catch {
    // Not configured: reported as down, details stay in server config.
    dbCheck = { ok: false, latencyMs: null };
  }
  return {
    status: dbCheck.ok ? 'ok' : 'degraded',
    version: APP_VERSION,
    time: new Date().toISOString(),
    checks: { db: dbCheck },
  };
}

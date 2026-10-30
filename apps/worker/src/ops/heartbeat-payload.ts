import { OPS_ALERT_CODES, type OpsAlert } from '@hmis/shared';
import type { OpsChecks } from '@hmis/shared/ops-node';
import { z } from 'zod';

/** Bump when a key is added or changed, so the receiver can tell old and new servers apart. */
export const HEARTBEAT_VERSION = 1;

/**
 * The only things the hospital server tells the vendor: counts, codes and a random install ID.
 * `.strict()` makes an extra key fail loudly; the allow-list test makes adding one a reviewed
 * change. Never add names, UHIDs, bill numbers, phones, free text or restricted-record counts.
 */
export const heartbeatPayloadSchema = z
  .object({
    v: z.literal(HEARTBEAT_VERSION),
    installId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    at: z.string().datetime(),
    status: z.enum(['ok', 'warn', 'critical']),
    alerts: z.array(z.enum(OPS_ALERT_CODES)),
    backupAgeMinutes: z.number().int().nonnegative().nullable(),
    diskUsedPct: z.number().min(0).max(100).nullable(),
    outboxBacklog: z.number().int().nonnegative().nullable(),
    queueLagSeconds: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;

export const HEARTBEAT_ALLOWED_KEYS = Object.keys(heartbeatPayloadSchema.shape).sort();

/** Install ID comes from `HMIS_INSTALL_ID` (random, never the hospital name); 'unset' otherwise. */
export function installIdFromEnv(env: Record<string, string | undefined>): string {
  const id = env.HMIS_INSTALL_ID?.trim();
  return id && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : 'unset-install';
}

export function buildHeartbeatPayload(opts: {
  installId: string;
  now: Date;
  alerts: readonly OpsAlert[];
  checks: Pick<OpsChecks, 'backup' | 'disk' | 'queue'>;
}): HeartbeatPayload {
  const { alerts, checks } = opts;
  const age = checks.backup.lastBackupAgeHours;
  return heartbeatPayloadSchema.parse({
    v: HEARTBEAT_VERSION,
    installId: opts.installId,
    at: opts.now.toISOString(),
    status: alerts.some((a) => a.severity === 'critical')
      ? 'critical'
      : alerts.length > 0
        ? 'warn'
        : 'ok',
    alerts: alerts.map((a) => a.code),
    backupAgeMinutes: age === null ? null : Math.round(age * 60),
    diskUsedPct: checks.disk.worst ? Math.round(checks.disk.worst.usedPct * 10) / 10 : null,
    outboxBacklog: checks.queue?.backlog ?? null,
    queueLagSeconds: checks.queue?.oldestAgeSeconds ?? null,
  });
}

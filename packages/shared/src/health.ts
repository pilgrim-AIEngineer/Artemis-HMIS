import { z } from 'zod';
import { opsAlertSchema } from './ops';

const backupTargetCheck = z.object({
  name: z.enum(['local', 'usb', 's3']),
  ok: z.boolean(),
  dbAgeHours: z.number().nullable(),
  filesAgeHours: z.number().nullable(),
  lastError: z.string().nullable(),
});

/**
 * Shape returned by `/api/health` and the `health.check` tRPC procedure. No PHI, ever.
 * `status` is `degraded` only when the database is unreachable (HTTP 503); stale backups, a full
 * disk or a long outbox only add `alerts` so they can never take the counter offline.
 */
export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.iso.datetime(),
  checks: z.object({
    db: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative().nullable(),
    }),
    disk: z.object({
      ok: z.boolean(),
      worst: z
        .object({
          path: z.string(),
          usedPct: z.number(),
          freeBytes: z.number(),
        })
        .nullable(),
    }),
    backup: z.object({
      ok: z.boolean(),
      state: z.enum(['ok', 'problem', 'missing']),
      lastBackupAgeHours: z.number().nullable(),
      targets: z.array(backupTargetCheck),
    }),
    queue: z
      .object({
        ok: z.boolean(),
        backlog: z.number().int().nonnegative(),
        oldestAgeSeconds: z.number().nonnegative().nullable(),
      })
      .nullable(),
  }),
  alerts: z.array(opsAlertSchema),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

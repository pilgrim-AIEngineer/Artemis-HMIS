import { z } from 'zod';

/** Shape returned by `/api/health` and the `health.check` tRPC procedure. No PHI, ever. */
export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.iso.datetime(),
  checks: z.object({
    db: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative().nullable(),
    }),
  }),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

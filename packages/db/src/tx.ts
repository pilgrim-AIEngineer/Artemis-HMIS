import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Db } from './client';

/** A Drizzle transaction handle as passed to `withTx` callbacks. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Who is acting. Becomes `SET LOCAL app.*`, read by the audit trigger and RLS policies. */
export interface TxContext {
  db: Db;
  /** NULL for system work (seed, worker jobs without a user). */
  userId: string | null;
  workstationId?: string | null;
  facilityId?: string | null;
  /** Permission keys of the session user, for `hmis_has_permission()` in RLS policies. */
  permissions?: readonly string[];
}

const permissionKey = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

const txSessionSchema = z.object({
  userId: z.uuid().nullable(),
  workstationId: z.uuid().nullable().default(null),
  facilityId: z.uuid().nullable().default(null),
  permissions: z.array(permissionKey).readonly().default([]),
});

/**
 * Runs `fn` in a transaction whose first statement sets `app.user_id`, `app.workstation_id`,
 * `app.facility_id` and `app.user_permissions` with transaction scope (`set_config(..., true)` is
 * `SET LOCAL`), so every audit row and RLS check sees the actor. All mutations go through here
 * (docs/02 §7).
 */
export async function withTx<T>(
  ctx: TxContext,
  fn: (tx: Tx) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  const s = txSessionSchema.parse({
    userId: ctx.userId,
    workstationId: ctx.workstationId ?? null,
    facilityId: ctx.facilityId ?? null,
    permissions: ctx.permissions ?? [],
  });
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.user_id', ${s.userId ?? ''}, true),
      set_config('app.workstation_id', ${s.workstationId ?? ''}, true),
      set_config('app.facility_id', ${s.facilityId ?? ''}, true),
      set_config('app.user_permissions', ${s.permissions.join(',')}, true)`);
    return fn(tx);
  }, config);
}

import { sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/** Current actor as set by `withTx` (`SET LOCAL app.user_id`); NULL for system jobs/seed. */
export const currentAppUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;

/** UUIDv7 primary key generated in the app (AGENTS.md rule 2). */
export const idColumn = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** `created_at/updated_at/created_by/updated_by` (AGENTS.md rule 3). `updated_*` are kept by the touch trigger. */
export const auditColumns = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid().default(currentAppUserId),
  updatedBy: uuid().default(currentAppUserId),
});

/** `col IN ('a', 'b')` for CHECK constraints built from the enums in @hmis/shared. */
export function sqlIn(column: AnyColumn, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`Unsafe enum literal: ${v}`);
  }
  return sql`${column} in ${sql.raw(`(${values.map((v) => `'${v}'`).join(', ')})`)}`;
}

import type { Tx } from '@hmis/db';
import { currentAppUserId } from '@hmis/db/schema';
import {
  cancelMasterSchema,
  masterListSchema,
  restoreMasterSchema,
  searchQueryText,
} from '@hmis/shared';
import type { Permission } from '@hmis/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { AuthSession } from '../../../auth/session';
import { appError, protectedProcedure } from '../../init';

/** Columns every master table has (packages/db/schema/masters.ts). */
export type MasterTable = PgTable & {
  id: AnyPgColumn;
  facilityId: AnyPgColumn;
  status: AnyPgColumn;
  cancelReason: AnyPgColumn;
  cancelledAt: AnyPgColumn;
  cancelledBy: AnyPgColumn;
  searchText: AnyPgColumn;
};

const pgCode = (err: unknown): { code?: string; constraint?: string } => {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return { code: e.code ?? e.cause?.code, constraint: e.constraint ?? e.cause?.constraint };
};

/**
 * Maps database constraint failures to user-facing i18n keys (docs/02 §7: never leak SQL). A
 * unique clash, a bad foreign key and a CHECK failure each get a stable key; `conflicts` can name
 * a constraint for a more specific message.
 */
export function translateDbError(err: unknown, conflicts: Record<string, string> = {}): never {
  const { code, constraint } = pgCode(err);
  if (code === '23505') {
    throw appError('CONFLICT', (constraint && conflicts[constraint]) || 'errors.masters.duplicate');
  }
  if (code === '23503') throw appError('BAD_REQUEST', 'errors.masters.badReference');
  if (code === '23514') throw appError('BAD_REQUEST', 'errors.masters.invalid');
  throw err;
}

export interface MasterCrudOptions<
  T extends MasterTable,
  L extends z.ZodObject,
  C extends z.ZodType,
  U extends z.ZodType<{ id: string }>,
> {
  table: T;
  permission: Permission;
  /** Column the browse list is ordered by (case-insensitively), e.g. `name`. */
  sortColumn: AnyPgColumn;
  listSchema: L;
  /** Extra WHERE built from the kind-specific list filters. */
  filter?: (input: z.output<L>) => SQL | undefined;
  createSchema: C;
  updateSchema: U;
  conflicts?: Record<string, string>;
  /** Validation that needs the database (references, protected rows). `existing` is null on create. */
  beforeWrite?: (
    tx: Tx,
    auth: AuthSession,
    input: unknown,
    existing: T['$inferSelect'] | null,
  ) => Promise<void>;
  afterWrite?: (tx: Tx, auth: AuthSession, id: string, input: unknown) => Promise<void>;
  beforeCancel?: (tx: Tx, auth: AuthSession, row: T['$inferSelect']) => Promise<void>;
}

const encodeCursor = (sort: string, id: string) =>
  Buffer.from(JSON.stringify([sort, id])).toString('base64url');

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const parsed = z.tuple([z.string(), z.uuid()]).parse(v);
    return parsed;
  } catch {
    throw appError('BAD_REQUEST', 'errors.masters.invalid');
  }
}

/**
 * List + create + update + cancel + restore procedures for one master (FND-07). Every procedure
 * declares `meta.permission` (docs/02 §7); rows are scoped to the session's facility; nothing is
 * ever deleted (AGENTS.md rule 4): `cancel` needs a reason, `restore` reverses it. Audit rows come
 * from the database trigger.
 */
export function masterCrud<
  T extends MasterTable,
  L extends z.ZodObject,
  C extends z.ZodType,
  U extends z.ZodType<{ id: string }>,
>(opts: MasterCrudOptions<T, L, C, U>) {
  // Non-generic view of the table: Drizzle's query builder cannot take an open generic.
  const table: MasterTable = opts.table;
  const proc = protectedProcedure.meta({ permission: opts.permission });
  type Row = T['$inferSelect'];

  const load = async (
    tx: Tx,
    facilityId: string,
    id: string,
    lock = false,
  ): Promise<Row | null> => {
    const q = tx
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.facilityId, facilityId)));
    const [row] = await (lock ? q.for('update') : q);
    return (row as Row | undefined) ?? null;
  };

  return {
    list: proc
      .input(opts.listSchema.extend(masterListSchema.shape))
      .query(async ({ ctx, input }) => {
        const base = input as z.output<L> & z.output<typeof masterListSchema>;
        const where: (SQL | undefined)[] = [
          eq(table.facilityId, ctx.auth.facilityId),
          opts.filter?.(base),
        ];
        if (!base.includeCancelled) where.push(eq(table.status, 'active'));
        const q = searchQueryText(base.search ?? '');
        const lowerSort = sql`lower(${opts.sortColumn})`;
        let order: SQL[] = [lowerSort, sql`${table.id}`];
        if (q) {
          where.push(sql`(${table.searchText} like ${`%${q}%`} or ${q} <% ${table.searchText})`);
          order = [sql`word_similarity(${q}, ${table.searchText}) desc`, ...order];
        } else if (base.cursor) {
          const [sortValue, id] = decodeCursor(base.cursor);
          where.push(sql`(${lowerSort}, ${table.id}) > (${sortValue}, ${id}::uuid)`);
        }
        const rows = (await ctx
          .db()
          .select()
          .from(table)
          .where(and(...where))
          .orderBy(...order)
          .limit(base.limit + 1)) as Row[];
        const page = rows.slice(0, base.limit);
        const last = page.at(-1);
        const nextCursor =
          !q && rows.length > base.limit && last
            ? encodeCursor(
                String((last[sortKey(opts.sortColumn)] as string).toLowerCase()),
                last.id as string,
              )
            : null;
        return { rows: page, nextCursor, truncated: !!q && rows.length > base.limit };
      }),

    create: proc.input(opts.createSchema).mutation(async ({ ctx, input }) => {
      const id = uuidv7();
      try {
        await ctx.tx(async (tx) => {
          await opts.beforeWrite?.(tx, ctx.auth, input, null);
          await tx
            .insert(table)
            .values({ ...(input as object), id, facilityId: ctx.auth.facilityId } as never);
          await opts.afterWrite?.(tx, ctx.auth, id, input);
        });
      } catch (err) {
        translateDbError(err, opts.conflicts);
      }
      return { id };
    }),

    update: proc.input(opts.updateSchema).mutation(async ({ ctx, input }) => {
      const { id, ...values } = input as { id: string } & Record<string, unknown>;
      try {
        await ctx.tx(async (tx) => {
          const existing = await load(tx, ctx.auth.facilityId, id, true);
          if (!existing) throw appError('NOT_FOUND', 'errors.notFound');
          if ((existing as { status: string }).status !== 'active') {
            throw appError('CONFLICT', 'errors.masters.cancelled');
          }
          await opts.beforeWrite?.(tx, ctx.auth, input, existing);
          await tx
            .update(table)
            .set(values)
            .where(and(eq(table.id, id), eq(table.facilityId, ctx.auth.facilityId)));
          await opts.afterWrite?.(tx, ctx.auth, id, input);
        });
      } catch (err) {
        translateDbError(err, opts.conflicts);
      }
      return { ok: true as const };
    }),

    cancel: proc.input(cancelMasterSchema).mutation(async ({ ctx, input }) => {
      await ctx.tx(async (tx) => {
        const row = await load(tx, ctx.auth.facilityId, input.id, true);
        if (!row) throw appError('NOT_FOUND', 'errors.notFound');
        if ((row as { status: string }).status !== 'active') {
          throw appError('CONFLICT', 'errors.masters.cancelled');
        }
        await opts.beforeCancel?.(tx, ctx.auth, row);
        await tx
          .update(table)
          .set({
            status: 'cancelled',
            cancelReason: input.reason,
            cancelledAt: sql`now()`,
            cancelledBy: currentAppUserId,
          })
          .where(eq(table.id, input.id));
      });
      return { ok: true as const };
    }),

    restore: proc.input(restoreMasterSchema).mutation(async ({ ctx, input }) => {
      try {
        await ctx.tx(async (tx) => {
          const row = await load(tx, ctx.auth.facilityId, input.id, true);
          if (!row) throw appError('NOT_FOUND', 'errors.notFound');
          if ((row as { status: string }).status !== 'cancelled') {
            throw appError('CONFLICT', 'errors.masters.notCancelled');
          }
          await tx
            .update(table)
            .set({
              status: 'active',
              cancelReason: null,
              cancelledAt: null,
              cancelledBy: null,
            })
            .where(eq(table.id, input.id));
        });
      } catch (err) {
        translateDbError(err, opts.conflicts);
      }
      return { ok: true as const };
    }),
  };
}

/** Property key of a Drizzle column on the row object (drizzle camelCases `name` → `name`). */
function sortKey(column: AnyPgColumn): string {
  // Row objects are keyed by the schema property name, which is the camelCase of the DB name.
  return column.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Throws unless `id` (when set) is an active row of `table` in the facility. */
export async function assertActiveRef(
  tx: Tx,
  table: MasterTable,
  facilityId: string,
  id: string | null | undefined,
  errorKey = 'errors.masters.badReference',
): Promise<void> {
  if (!id) return;
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.facilityId, facilityId), eq(table.status, 'active')));
  if (!row) throw appError('BAD_REQUEST', errorKey);
}

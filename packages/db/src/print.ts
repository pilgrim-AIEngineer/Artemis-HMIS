import { and, eq, inArray, sql } from 'drizzle-orm';
import { printLog } from '../schema';
import type { Db } from './client';
import type { Tx } from './tx';

type Queryable = Db | Tx;

export interface PrintTarget {
  facilityId: string;
  template: string;
  entityId: string;
  /**
   * All templates that print the same document in another layout (a receipt on the 80 mm roll and
   * on A5): they share one copy sequence, so the second layout of a receipt is a DUPLICATE too.
   * Defaults to `[template]`.
   */
  family?: readonly string[];
}

const familyOf = (t: PrintTarget): string[] =>
  [...new Set([t.template, ...(t.family ?? [])])].sort();

/** The copy number the next print of this document gets (1 = original, >1 = DUPLICATE). */
export async function nextCopyNo(q: Queryable, t: PrintTarget): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`coalesce(max(${printLog.copyNo}), 0)::int` })
    .from(printLog)
    .where(
      and(
        eq(printLog.facilityId, t.facilityId),
        inArray(printLog.template, familyOf(t)),
        eq(printLog.entityId, t.entityId),
      ),
    );
  return (row?.n ?? 0) + 1;
}

export interface RecordPrintInput extends PrintTarget {
  entity: string;
  userId: string;
  workstationId?: string | null;
}

/**
 * Appends a `print_log` row with the next copy number (docs/01 §4). Concurrent prints of one
 * document are serialised by a transaction-scoped advisory lock, so copy numbers are gap-free
 * and unique (the unique index is the backstop). Call inside the business transaction.
 */
export async function recordPrint(
  tx: Tx,
  input: RecordPrintInput,
): Promise<{ id: string; copyNo: number }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`print:${input.facilityId}:${familyOf(input).join(',')}:${input.entityId}`}, 0))`,
  );
  const copyNo = await nextCopyNo(tx, input);
  const [row] = await tx
    .insert(printLog)
    .values({
      facilityId: input.facilityId,
      template: input.template,
      entity: input.entity,
      entityId: input.entityId,
      copyNo,
      userId: input.userId,
      workstationId: input.workstationId ?? null,
    })
    .returning({ id: printLog.id });
  return { id: row!.id, copyNo };
}

/**
 * The print_log time of copy `copyNo` if `userId` printed it, else null. The print page uses it to
 * draw exactly the copy that was logged (same time on refresh) and to refuse invented copy numbers.
 */
export async function findPrintCopy(
  q: Queryable,
  t: PrintTarget & { userId: string; copyNo: number },
): Promise<{ printedAt: Date } | null> {
  const [row] = await q
    .select({ printedAt: printLog.createdAt })
    .from(printLog)
    .where(
      and(
        eq(printLog.facilityId, t.facilityId),
        eq(printLog.template, t.template),
        eq(printLog.entityId, t.entityId),
        eq(printLog.copyNo, t.copyNo),
        eq(printLog.userId, t.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

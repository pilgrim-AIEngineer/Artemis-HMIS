import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { idempotency } from '../schema';
import type { Tx } from './tx';

/** Same (facility, procedure, key) reused with a different request payload. Maps to tRPC CONFLICT. */
export class IdempotencyConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('idempotency.conflict');
    this.name = 'IdempotencyConflictError';
  }
}

function canonicalize(v: unknown): unknown {
  if (typeof v === 'bigint') return `${v}n`;
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonicalize(x)]),
    );
  }
  return v;
}

/** sha256 hex of the key-order-independent JSON form of `payload`. */
export function hashRequest(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload) ?? null))
    .digest('hex');
}

export interface IdempotentCall {
  facilityId: string;
  userId: string | null;
  procedure: string;
  key: string;
  /** The request input (without the key itself). */
  payload: unknown;
}

/**
 * docs/02 §7, AGENTS.md rule 9. Call inside `withTx`. First call runs `fn` and stores its JSON
 * result; a replay (same facility, procedure, key and payload hash) returns the stored result
 * without running `fn`; the same key with a different payload throws `IdempotencyConflictError`.
 * A per-key advisory lock serialises concurrent duplicate submits.
 */
export async function runIdempotent<T>(
  tx: Tx,
  call: IdempotentCall,
  fn: () => Promise<T>,
): Promise<T> {
  const key = z.uuid().parse(call.key);
  const requestHash = hashRequest(call.payload);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`idem:${call.facilityId}:${call.procedure}:${key}`}, 0))`,
  );
  const [existing] = await tx
    .select({ requestHash: idempotency.requestHash, result: idempotency.result })
    .from(idempotency)
    .where(
      and(
        eq(idempotency.facilityId, call.facilityId),
        eq(idempotency.procedure, call.procedure),
        eq(idempotency.key, key),
      ),
    );
  if (existing) {
    if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
    return existing.result as T;
  }
  const result = await fn();
  await tx.insert(idempotency).values({
    id: uuidv7(),
    facilityId: call.facilityId,
    userId: call.userId,
    procedure: call.procedure,
    key,
    requestHash,
    result: result ?? null,
  });
  return result;
}

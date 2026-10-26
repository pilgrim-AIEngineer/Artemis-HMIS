import { sql } from 'drizzle-orm';
import type { Db } from './client';

export interface OutboxLag {
  backlog: number;
  oldestAgeSeconds: number | null;
}

/**
 * Messages that are due (`send_after` passed) and not yet sent, across facilities, for
 * `/api/health` and the ops jobs (docs/31 §5: alert above 500). Counts only; no patient data.
 */
export async function getOutboxLag(db: Db, now: Date = new Date()): Promise<OutboxLag> {
  const res = await db.execute<{ backlog: string; oldest: Date | null }>(sql`
    select count(*)::text as backlog, min(send_after) as oldest
    from message_outbox
    where status in ('queued', 'sending') and send_after <= ${now.toISOString()}::timestamptz
  `);
  const row = res.rows[0];
  const oldest = row?.oldest ? new Date(row.oldest).getTime() : null;
  return {
    backlog: Number(row?.backlog ?? 0),
    oldestAgeSeconds:
      oldest === null ? null : Math.max(0, Math.round((now.getTime() - oldest) / 1000)),
  };
}

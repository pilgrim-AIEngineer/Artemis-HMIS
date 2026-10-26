import type { Permission } from '@hmis/shared';
import { sessionTokenFromHeaders, resolveSession } from '@/server/auth/session';
import { getDb } from '@/server/db';
import { getEventHub } from '@/server/events';
import { createEventStream } from '@/server/events/stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Permissions that may watch queue changes; the events carry ids only, data is re-read via tRPC. */
const QUEUE_WATCHERS: Permission[] = ['patient.view', 'queue.manage', 'queue.call'];

const plain = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

/**
 * Server-Sent Events for live screens (docs/01 §2): fed by Postgres LISTEN/NOTIFY through the
 * process-wide hub. 401/403 without an active session or a queue permission; 503 while the
 * listener connection is down, so the client polls every 5 s and retries.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await resolveSession(getDb(), sessionTokenFromHeaders(req.headers), new Date());
  if (!auth) return plain(401);
  if (auth.state !== 'active' || !QUEUE_WATCHERS.some((p) => auth.permissions.has(p))) {
    return plain(403);
  }
  const hub = getEventHub();
  await hub.start();
  if (!hub.isUp) return plain(503, { 'Retry-After': '5' });
  return new Response(createEventStream(hub, auth.facilityId, { signal: req.signal }), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

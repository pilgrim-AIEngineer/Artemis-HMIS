import { displayFeed, facilityForDisplayKey } from '@hmis/db';
import { DISPLAY_KEY_HEADER } from '@hmis/shared';
import { getDb } from '@/server/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/** Wrong keys per client address in the last minute: a guessing brake (keys are 256-bit anyway). */
const FAILURES = new Map<string, { count: number; since: number }>();
const WINDOW_MS = 60_000;
const MAX_FAILURES = 30;

function clientAddress(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

function blocked(addr: string, now: number): boolean {
  const f = FAILURES.get(addr);
  if (!f) return false;
  if (now - f.since > WINDOW_MS) {
    FAILURES.delete(addr);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function noteFailure(addr: string, now: number) {
  const f = FAILURES.get(addr);
  if (!f || now - f.since > WINDOW_MS) FAILURES.set(addr, { count: 1, since: now });
  else f.count++;
  if (FAILURES.size > 1000) FAILURES.clear();
}

/**
 * Feed for the waiting-hall TV (REG-05): token numbers per doctor, nothing else about a patient
 * unless `queue.showNameOnDisplay` is on. No session: the display key (header, not URL) is the
 * credential. A wrong, malformed or rotated key is a plain 404.
 */
export async function GET(req: Request): Promise<Response> {
  const now = Date.now();
  const addr = clientAddress(req);
  if (blocked(addr, now)) {
    return new Response(null, { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } });
  }
  const db = getDb();
  const facilityId = await facilityForDisplayKey(db, req.headers.get(DISPLAY_KEY_HEADER) ?? '');
  if (!facilityId) {
    noteFailure(addr, now);
    return new Response(null, { status: 404, headers: NO_STORE });
  }
  const feed = await displayFeed(db, facilityId, new Date(now));
  return Response.json(feed, { headers: NO_STORE });
}

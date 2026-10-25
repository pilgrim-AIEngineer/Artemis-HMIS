import { getHealth } from '@/server/health';

export const dynamic = 'force-dynamic';

/** For Uptime Kuma / healthchecks / compose healthcheck. 503 when the DB is unreachable. */
export async function GET() {
  const health = await getHealth();
  return Response.json(health, {
    status: health.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

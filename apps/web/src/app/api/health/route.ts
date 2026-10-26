import { getHealth } from '@/server/health';

export const dynamic = 'force-dynamic';

/**
 * For Uptime Kuma / healthchecks / compose healthcheck. 503 when the DB is unreachable.
 * `?strict=1` also answers 503 while any alert is open (stale backup, full disk …) for monitors
 * and `backup-check.sh`; the default never fails on those so the counter is not affected.
 */
export async function GET(request: Request) {
  const health = await getHealth();
  const strict = new URL(request.url).searchParams.get('strict') === '1';
  const failing = health.status !== 'ok' || (strict && health.alerts.length > 0);
  return Response.json(health, {
    status: failing ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

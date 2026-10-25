import { isIpAddress } from '@hmis/shared';
import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth-constants';
import { parseCookies } from './cookies';
import { safeEqual } from './tokens';

/**
 * Client address. Caddy replaces any client-sent `X-Forwarded-For` with the peer address
 * (no trusted proxies configured), and Next fills it with the socket address only when absent,
 * so the rightmost entry is the browser's IP. Unknown/invalid → null (treated as remote).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for');
  const last = xff?.split(',').at(-1)?.trim();
  return last && isIpAddress(last) ? last : null;
}

export type CsrfFailure = 'cross-site' | 'origin' | 'token';

/**
 * CSRF for state-changing requests (docs/01 §9): the request must be same-origin
 * (`Sec-Fetch-Site`, else `Origin` vs `Host`) AND echo the double-submit cookie in
 * `x-csrf-token`. SameSite=Lax on the session cookie is the third layer. Safe methods pass.
 */
export function checkCsrf(req: Request): CsrfFailure | null {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'cross-site';
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) return 'origin';
  try {
    if (new URL(origin).host !== host) return 'origin';
  } catch {
    return 'origin';
  }
  const cookie = parseCookies(req.headers.get('cookie'))[CSRF_COOKIE];
  const header = req.headers.get(CSRF_HEADER);
  if (!cookie || !header || cookie.length < 16 || !safeEqual(cookie, header)) return 'token';
  return null;
}

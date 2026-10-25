import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE } from '@/lib/auth-constants';

/**
 * docs/01 §9 security headers, per request:
 * - strict CSP with a fresh script nonce (Next applies it to its own scripts), no inline
 *   scripts, no framing, no plugins, same-origin connections only;
 * - the double-submit CSRF cookie the tRPC client echoes on every mutation (FND-02).
 * Session checks stay in the server layouts and the tRPC middleware (the proxy is not an
 * authorisation layer).
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Radix/next inject inline style attributes; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);

  if (!request.cookies.get(CSRF_COOKIE)) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    response.cookies.set(CSRF_COOKIE, token, {
      path: '/',
      sameSite: 'strict',
      secure: true,
      httpOnly: false,
      maxAge: 365 * 24 * 3600,
    });
  }
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

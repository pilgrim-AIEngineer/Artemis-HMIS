/** Minimal cookie parse/serialise (RFC 6265) so tRPC can work from plain `Request` headers. */

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    const raw = part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  /** Seconds; 0 deletes the cookie. Omit for a browser-session cookie. */
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict';
  path?: string;
}

/**
 * Always `Secure` (docs/01 §5): LAN clients reach the app only through Caddy's HTTPS; browsers
 * also accept Secure cookies from http://localhost / 127.0.0.1 for development and E2E.
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('bad cookie name');
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'Secure'];
  if (opts.httpOnly ?? true) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
    if (opts.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

import { describe, expect, it } from 'vitest';
import { parseCookies, serializeCookie } from './cookies';
import { checkCsrf, clientIpFromHeaders } from './request';
import { openSecret, sealSecret, SecretKeyMissingError } from './secret-box';
import { isIdle } from './session';
import { base32Decode, base32Encode, totpCode, totpStep, totpUri, verifyTotp } from './totp';

describe('TOTP (RFC 6238 SHA-1 vectors, 6 digits)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const at = (s: number) => new Date(s * 1000);

  it('base32 round-trips', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3t qojq====').toString()).toBe('1234567890');
    expect(() => base32Decode('01')).toThrow();
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('T=%i → %s', (t, code) => {
    expect(totpCode(secret, totpStep(at(t)))).toBe(code);
  });

  it('accepts ±1 step, refuses replays and other codes', () => {
    const now = at(1234567890);
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, '000000', now, null)).toBeNull();
  });

  it('builds an otpauth URI', () => {
    expect(totpUri('ABC', 'owner', 'HMIS')).toBe(
      'otpauth://totp/HMIS%3Aowner?secret=ABC&issuer=HMIS&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('cookies', () => {
  it('parses, decodes and keeps the first duplicate', () => {
    expect(parseCookies('a=1; b=x%20y; a=2; bad; c="q"')).toEqual({ a: '1', b: 'x y', c: 'q' });
    expect(parseCookies(null)).toEqual({});
  });

  it('serialises Secure + HttpOnly + SameSite=Lax by default, and deletions', () => {
    expect(serializeCookie('hmis_session', 'tok', { maxAge: 60 })).toBe(
      'hmis_session=tok; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60',
    );
    expect(serializeCookie('x', '', { maxAge: 0, httpOnly: false })).toMatch(
      /^x=; Path=\/; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970/,
    );
    expect(() => serializeCookie('bad name', 'v')).toThrow();
  });
});

describe('CSRF check', () => {
  const token = 'csrf-token-0123456789abcdef';
  const post = (headers: Record<string, string>) =>
    new Request('https://hmis.local/api/trpc/auth.login', { method: 'POST', headers });
  const good = {
    host: 'hmis.local',
    origin: 'https://hmis.local',
    'sec-fetch-site': 'same-origin',
    cookie: `hmis_csrf=${token}`,
    'x-csrf-token': token,
  };

  it('passes same-origin POSTs that echo the cookie, and all GETs', () => {
    expect(checkCsrf(post(good))).toBeNull();
    expect(checkCsrf(new Request('https://hmis.local/api/trpc/auth.me'))).toBeNull();
  });

  it('rejects cross-site, foreign origin, missing origin and token mismatch', () => {
    expect(checkCsrf(post({ ...good, 'sec-fetch-site': 'cross-site' }))).toBe('cross-site');
    expect(checkCsrf(post({ ...good, 'sec-fetch-site': 'same-site' }))).toBe('cross-site');
    expect(checkCsrf(post({ ...good, origin: 'https://evil.example' }))).toBe('origin');
    const { origin: _o, ...noOrigin } = good;
    expect(checkCsrf(post(noOrigin))).toBe('origin');
    expect(checkCsrf(post({ ...good, 'x-csrf-token': 'csrf-token-0123456789abcdeX' }))).toBe(
      'token',
    );
    const { 'x-csrf-token': _t, ...noHeader } = good;
    expect(checkCsrf(post(noHeader))).toBe('token');
    expect(checkCsrf(post({ ...good, cookie: 'other=1' }))).toBe('token');
  });
});

describe('clientIpFromHeaders', () => {
  it('takes the rightmost X-Forwarded-For entry and rejects junk', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '192.168.1.5' }))).toBe(
      '192.168.1.5',
    );
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '10.0.0.1, 100.64.3.2' }))).toBe(
      '100.64.3.2',
    );
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'unknown' }))).toBeNull();
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });
});

describe('secret box', () => {
  const env = { HMIS_SECRET_KEY: 'k'.repeat(40) } as unknown as NodeJS.ProcessEnv;

  it('round-trips, randomises IVs and detects tampering or a wrong key', () => {
    const a = sealSecret('JBSWY3DPEHPK3PXP', env);
    expect(a).not.toBe(sealSecret('JBSWY3DPEHPK3PXP', env));
    expect(openSecret(a, env)).toBe('JBSWY3DPEHPK3PXP');
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => openSecret(parts.join('.'), env)).toThrow();
    expect(() =>
      openSecret(a, { HMIS_SECRET_KEY: 'j'.repeat(40) } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('requires a key of at least 32 characters', () => {
    expect(() =>
      sealSecret('x', { HMIS_SECRET_KEY: 'short' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(SecretKeyMissingError);
  });
});

describe('isIdle', () => {
  it('is idle exactly at the limit', () => {
    const t0 = new Date('2026-10-25T10:00:00Z');
    expect(isIdle(t0, new Date('2026-10-25T10:09:59Z'), 10)).toBe(false);
    expect(isIdle(t0, new Date('2026-10-25T10:10:00Z'), 10)).toBe(true);
  });
});

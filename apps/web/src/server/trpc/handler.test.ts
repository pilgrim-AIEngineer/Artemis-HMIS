/**
 * `/api/trpc` over HTTP: CSRF runs before any procedure, cookies travel as in a browser.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PASSWORD, setupAuthFixture, type AuthFixture } from '../../../test/auth-fixture';
import { createTrpcHandler } from './handler';

let f: AuthFixture;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
  handler = createTrpcHandler({ db: () => f.db });
});

afterAll(async () => {
  await f.close();
});

const CSRF = 'csrf-http-test-0123456789';
const base = 'https://hmis.local/api/trpc';

const sameOrigin = {
  'content-type': 'application/json',
  host: 'hmis.local',
  origin: 'https://hmis.local',
  'sec-fetch-site': 'same-origin',
  'x-forwarded-for': '192.168.1.40',
  cookie: `hmis_csrf=${CSRF}`,
  'x-csrf-token': CSRF,
};

/** POST auth.login; `null` header values are left out. */
function login(username: string, headers: Record<string, string | null> = {}) {
  const merged = Object.entries({ ...sameOrigin, ...headers }).filter(
    (e): e is [string, string] => e[1] !== null,
  );
  return handler(
    new Request(`${base}/auth.login`, {
      method: 'POST',
      headers: Object.fromEntries(merged),
      body: JSON.stringify({ json: { username, password: PASSWORD } }),
    }),
  );
}

describe('tRPC HTTP handler', () => {
  it('signs in with a valid CSRF token and returns the session cookie', async () => {
    const res = await login(f.users.reception.username);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-hmis_session='));
    expect(cookie).toMatch(/HttpOnly; SameSite=Lax/);

    const token = cookie!.split(';')[0]!;
    const me = await handler(
      new Request(`${base}/auth.me`, { headers: { cookie: token, host: 'hmis.local' } }),
    );
    const body = (await me.json()) as { result: { data: { json: { username: string } } } };
    expect(body.result.data.json.username).toBe(f.users.reception.username);
  });

  it('serves a query sent by POST, so its input never has to be in a URL (rule 15)', async () => {
    const res = await login(f.users.reception.username);
    const token = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-hmis_session='))!
      .split(';')[0]!;
    const me = await handler(
      new Request(`${base}/auth.me`, {
        method: 'POST',
        headers: { ...sameOrigin, cookie: `${token}; hmis_csrf=${CSRF}`, host: 'hmis.local' },
        body: JSON.stringify({ json: null }),
      }),
    );
    expect(me.status).toBe(200);
    const body = (await me.json()) as { result: { data: { json: { username: string } } } };
    expect(body.result.data.json.username).toBe(f.users.reception.username);
    // …and the POST still needs the CSRF token like any other.
    const bare = await handler(
      new Request(`${base}/auth.me`, {
        method: 'POST',
        headers: { ...sameOrigin, 'x-csrf-token': '', cookie: token, host: 'hmis.local' },
        body: JSON.stringify({ json: null }),
      }),
    );
    expect(bare.status).toBe(403);
  });

  it.each([
    ['a cross-site POST', { 'sec-fetch-site': 'cross-site' }],
    ['a foreign Origin', { origin: 'https://evil.example', 'sec-fetch-site': null }],
    ['no Origin', { origin: null, 'sec-fetch-site': null }],
    ['a missing token header', { 'x-csrf-token': null }],
    ['a token that does not match the cookie', { 'x-csrf-token': 'csrf-http-test-XXXXXXXXXX' }],
  ])('rejects %s with 403 before running the procedure', async (_name, headers) => {
    const res = await login(f.users.reception.username, headers);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'errors.auth.csrf',
    );
  });

  it('uses X-Forwarded-For for remote detection (owner from Tailscale needs TOTP)', async () => {
    const res = await login(f.users.owner.username, { 'x-forwarded-for': '100.70.1.1' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { json: { message: string } } };
    expect(body.error.json.message).toBe('errors.auth.totpNotEnrolled');
    expect((await login(f.users.owner.username)).status).toBe(200);
  });
});

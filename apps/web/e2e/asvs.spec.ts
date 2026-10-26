/**
 * OWASP ASVS L1 evidence against the real stack (docs/34-asvs-l1.md, OPS-01): session cookie
 * attributes (3.4), logout really ends the session (3.3.1), CSRF (4.2.2), unauthenticated API
 * access (4.1.1), anti-caching and security headers (8.2.1, 14.4, 14.5). Runs once, on desktop.
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { signInReady } from './helpers';

test.beforeEach(({ page: _page }, info) => {
  test.skip(info.project.name !== 'desktop', 'protocol checks run once');
});

/** POST to a tRPC procedure like the browser client does (same origin + double-submit token). */
async function call(page: Page, path: string, input: unknown, opts: { csrf?: boolean } = {}) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'hmis_csrf')?.value ?? '';
  const origin = new URL(page.url()).origin;
  return page.request.post(`/api/trpc/${path}`, {
    headers: {
      'content-type': 'application/json',
      origin,
      ...(opts.csrf === false ? {} : { 'x-csrf-token': csrf }),
    },
    data: input === undefined ? undefined : JSON.stringify({ json: input }),
  });
}

test('session cookie is HttpOnly, Secure and SameSite; logout ends the session server-side', async ({
  page,
}) => {
  await signInReady(page, E2E_USERS.reception);
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === '__Host-hmis_session')!;
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
  expect(session.value.length).toBeGreaterThanOrEqual(43); // 256-bit random token

  const me = await call(page, 'auth.me', undefined);
  expect(
    ((await me.json()) as { result: { data: { json: unknown } } }).result.data.json,
  ).not.toBeNull();

  const out = await call(page, 'auth.logout', undefined);
  expect(out.status()).toBe(200);
  // Replaying the old cookie after logout must not work (3.3.1): put it back by hand.
  await page.context().addCookies([session]);
  const replay = await call(page, 'patients.search', { q: 'a' });
  expect(replay.status()).toBe(401);
  const who = await call(page, 'auth.me', undefined); // public: answers null, not the user
  expect(
    ((await who.json()) as { result: { data: { json: unknown } } }).result.data.json,
  ).toBeNull();
});

test('a state-changing request needs the CSRF token and a same-origin Origin', async ({ page }) => {
  await signInReady(page, E2E_USERS.reception);
  const noToken = await call(page, 'auth.heartbeat', undefined, { csrf: false });
  expect(noToken.status()).toBe(403);
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'hmis_csrf')!.value;
  const crossSite = await page.request.post('/api/trpc/auth.heartbeat', {
    headers: { origin: 'https://evil.example', 'x-csrf-token': csrf },
  });
  expect(crossSite.status()).toBe(403);
});

test('the API and files refuse a caller without a session', async ({ page, request }) => {
  await page.goto('/login'); // the proxy hands out the CSRF cookie, so only the session is missing
  const trpc = await call(page, 'patients.search', { q: 'a' });
  expect(trpc.status()).toBe(401);
  const file = await request.get('/api/documents/rx-scan/0199c9a0-0000-7000-8000-000000000000');
  expect(file.status()).toBe(401);
  const events = await request.get('/api/events');
  expect(events.status()).toBe(401);
});

test('pages are not cached and carry the security headers; nothing names the framework', async ({
  page,
}) => {
  await signInReady(page, E2E_USERS.reception);
  const res = (await page.goto('/reception'))!;
  const h = await res.allHeaders();
  expect(h['cache-control']).toMatch(/no-store/);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-powered-by']).toBeUndefined();

  const api = await call(page, 'auth.me', undefined);
  expect(api.headers()['cache-control']).toBe('no-store');
});

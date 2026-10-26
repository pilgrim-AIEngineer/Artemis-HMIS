// Shared helpers for the HMIS k6 scripts: tRPC over HTTP (superjson, queries by POST like the
// browser client), session login and CSRF double-submit. Synthetic demo users only.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

export const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
export const USERNAME = __ENV.LOAD_USER || 'demo_reception';
export const PASSWORD = __ENV.LOAD_PASSWORD || 'demo-pass-2026';
const CSRF = 'k6-load-csrf-0123456789abcdef';

export const businessErrors = new Counter('hmis_business_errors');

// The session cookie is `Secure`, which k6's cookie jar will not send over plain http (the browser
// treats 127.0.0.1 as secure, k6 does not), so the Cookie header is built by hand. Per-VU state.
let sessionCookie = ''; // `name=value` of the session cookie
let signedIn = false;

const headers = () => ({
  'content-type': 'application/json',
  origin: BASE,
  'x-csrf-token': CSRF,
  cookie: `hmis_csrf=${CSRF}${sessionCookie ? `; ${sessionCookie}` : ''}`,
});

export function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += h[8 + Math.floor(Math.random() * 4)];
    else s += h[Math.floor(Math.random() * 16)];
  }
  return s;
}

export const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
export const int = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export function login() {
  sessionCookie = '';
  const res = http.post(
    `${BASE}/api/trpc/auth.login`,
    JSON.stringify({ json: { username: USERNAME, password: PASSWORD } }),
    { headers: headers(), tags: { name: 'auth.login', kind: 'auth' } },
  );
  if (res.status !== 200) fail(`login failed: HTTP ${res.status} ${res.body}`);
  const name = ['__Host-hmis_session', 'hmis_session'].find((n) => res.cookies[n]);
  if (!name) fail('login returned no session cookie');
  sessionCookie = `${name}=${res.cookies[name][0].value}`;
  signedIn = true;
}

/**
 * Calls a tRPC procedure. `bigints` lists input paths holding paise (`tenders.0.amountPaise`),
 * which superjson sends as strings plus a `meta` entry. Returns { res, data, ok }.
 * kind: 'query' | 'mutation' is used for the thresholds (search p95 < 300 ms, mutations < 1 s).
 */
export function trpc(path, input, { kind, tag, bigints } = {}) {
  if (!signedIn) login();
  const body = {};
  if (input !== undefined) body.json = input;
  if (bigints && bigints.length) {
    const values = {};
    for (const p of bigints) values[p] = ['bigint'];
    body.meta = { values };
  }
  const res = http.post(
    `${BASE}/api/trpc/${path}`,
    input === undefined ? null : JSON.stringify(body),
    { headers: headers(), tags: { name: tag || path, kind: kind || 'query' } },
  );
  if (res.status === 401) {
    signedIn = false; // session expired or locked: sign in again on the next call
  }
  const ok = check(res, { [`${tag || path} 200`]: (r) => r.status === 200 });
  if (!ok) {
    businessErrors.add(1, { name: tag || path, status: String(res.status) });
    // Procedure, status and the error key only: inputs may hold patient data.
    let key = '';
    try {
      key = res.json('error.json.message');
    } catch {
      key = String(res.body).slice(0, 80);
    }
    console.warn(`${tag || path}: HTTP ${res.status} ${key}`);
  }
  let data = null;
  if (res.status === 200) {
    try {
      data = res.json('result.data.json');
    } catch {
      data = null;
    }
  }
  return { res, data, ok };
}

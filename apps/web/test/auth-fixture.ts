/**
 * Integration-test fixture for FND-02/03: a migrated database with two facilities (A, B), the
 * default roles, a set of users, and `TestBrowser` — a cookie jar in front of the tRPC caller
 * with an injectable clock, so lockout, idle lock and expiry are tested without waiting.
 */
import { ensureFacilityRbac, insertUser, withTx, type Db } from '@hmis/db';
import { setupPlatformDb, seedFacility, type PlatformTestDb } from '@hmis/db/testing/platform';
import { TRPCError } from '@trpc/server';
import { CSRF_COOKIE } from '@/lib/auth-constants';
import type { Context } from '@/server/trpc/init';
import { createCaller } from '@/server/trpc/root';

export const PASSWORD = 'test-pass-2026';
export const PIN = '2580';
export const TEST_SECRET_KEY = 'test-secret-key-0123456789abcdefghijklmnop';

export interface Clock {
  now: Date;
  advance(ms: number): void;
}

export const createClock = (): Clock => ({
  now: new Date(),
  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms);
  },
});

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export type Caller = ReturnType<typeof createCaller>;

export class TestBrowser {
  readonly cookies = new Map<string, string>();
  clientIp: string | null = '192.168.1.50';

  constructor(
    readonly db: Db,
    readonly clock: Clock,
  ) {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  context(): Context {
    const headers = new Headers();
    if (this.cookies.size) headers.set('cookie', this.cookieHeader());
    return {
      db: () => this.db,
      headers,
      resHeaders: new Headers(),
      clientIp: this.clientIp,
      now: () => this.clock.now,
    };
  }

  /** Applies `Set-Cookie` lines (name=value; ...; Max-Age=0 deletes). */
  absorb(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = decodeURIComponent(pair!.slice(eq + 1));
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call<T>(fn: (c: Caller) => Promise<T>): Promise<T> {
    const ctx = this.context();
    try {
      return await fn(createCaller(ctx));
    } finally {
      this.absorb(ctx.resHeaders?.getSetCookie() ?? []);
    }
  }

  login(username: string, password = PASSWORD) {
    return this.call((c) => c.auth.login({ username, password }));
  }
}

/** Resolves to the TRPCError a promise rejects with (fails the test if it resolves). */
export async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TRPCError) return err;
    throw err;
  }
  throw new Error('expected a TRPCError, but the call succeeded');
}

export interface AuthFixture {
  t: PlatformTestDb;
  db: Db;
  a: { facilityId: string; workstationId: string };
  b: { facilityId: string };
  users: Record<
    'admin' | 'owner' | 'reception' | 'nurse' | 'noRoles' | 'noPin' | 'adminB',
    { id: string; username: string }
  >;
  browser(clock?: Clock): TestBrowser;
  close(): Promise<void>;
}

let seq = 0;

export async function setupAuthFixture(adminUrl: string): Promise<AuthFixture> {
  process.env.HMIS_SECRET_KEY ??= TEST_SECRET_KEY;
  const t = await setupPlatformDb(adminUrl);
  const a = await seedFacility(t.owner, 'Hospital A');
  const b = await seedFacility(t.owner, 'Hospital B');
  const tag = `${process.pid}${(seq++).toString(36)}`;
  const users = await withTx({ db: t.app, userId: null }, async (tx) => {
    await ensureFacilityRbac(tx, a.facilityId);
    await ensureFacilityRbac(tx, b.facilityId);
    const make = async (
      key: string,
      facilityId: string,
      roles: string[],
      opts: { pin?: string | null } = {},
    ) => {
      const username = `${key}_${tag}`.toLowerCase();
      const id = await insertUser(tx, {
        facilityId,
        username,
        fullName: `Test ${key}`,
        password: PASSWORD,
        pin: opts.pin === null ? undefined : (opts.pin ?? PIN),
        roles,
      });
      return { id, username };
    };
    return {
      admin: await make('admin', a.facilityId, ['admin']),
      owner: await make('owner', a.facilityId, ['owner']),
      reception: await make('reception', a.facilityId, ['reception']),
      nurse: await make('nurse', a.facilityId, ['nurse']),
      noRoles: await make('noroles', a.facilityId, []),
      noPin: await make('nopin', a.facilityId, ['reception'], { pin: null }),
      adminB: await make('adminb', b.facilityId, ['admin']),
    };
  });
  return {
    t,
    db: t.app,
    a: { facilityId: a.facilityId, workstationId: a.workstationId },
    b: { facilityId: b.facilityId },
    users,
    browser: (clock = createClock()) => {
      const br = new TestBrowser(t.app, clock);
      br.cookies.set(CSRF_COOKIE, 'csrf-test-token-0123456789');
      return br;
    },
    close: () => t.close(),
  };
}

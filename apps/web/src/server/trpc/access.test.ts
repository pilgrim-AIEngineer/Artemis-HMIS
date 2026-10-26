/**
 * FND-03 gate: walks the whole router. Every procedure must declare `.meta({ permission })`,
 * and every non-public procedure must reject callers without a session, without the
 * permission, with a locked session, and with a pending TOTP step.
 */
import { DEFAULT_ROLE_PERMISSIONS } from '@hmis/db';
import { session } from '@hmis/db/schema';
import { isPermission } from '@hmis/shared';
import type { AnyProcedure } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  MINUTE,
  setupAuthFixture,
  trpcError,
  type AuthFixture,
  type Caller,
  type TestBrowser,
} from '../../../test/auth-fixture';
import { ACCESS_RULES, isAccessRule, type AccessRule } from './init';
import { appRouter } from './root';

let f: AuthFixture;

beforeAll(async () => {
  f = await setupAuthFixture(inject('testPgAdminUrl'));
});

afterAll(async () => {
  await f.close();
});

const procedures = Object.entries(
  appRouter._def.procedures as unknown as Record<string, AnyProcedure>,
).map(([path, proc]) => ({
  path,
  rule: (proc._def.meta as { permission?: unknown } | undefined)?.permission,
}));

/** Calls `path` on a caller with junk input; access is checked before input validation. */
function invoke(caller: Caller, path: string): Promise<unknown> {
  const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller);
  return (fn as (input: unknown) => Promise<unknown>)(undefined);
}

const ruleOf = (path: string) => procedures.find((p) => p.path === path)!.rule as AccessRule;
const nonPublic = () => procedures.filter((p) => p.rule !== 'public');

describe('router walk: every procedure declares a permission', () => {
  it('finds the routers', () => {
    expect(procedures.length).toBeGreaterThan(25);
  });

  it.each(procedures)('$path has a valid meta.permission', ({ rule }) => {
    expect(isAccessRule(rule)).toBe(true);
  });

  it('keeps the public surface to an explicit allow-list', () => {
    expect(
      procedures
        .filter((p) => p.rule === 'public')
        .map((p) => p.path)
        .sort(),
    ).toEqual(['auth.login', 'auth.me', 'health.check']);
  });

  it('uses only documented permission keys or named session rules', () => {
    for (const { path, rule } of procedures) {
      expect(isPermission(rule) || Object.hasOwn(ACCESS_RULES, rule as string), path).toBe(true);
    }
  });
});

describe('unauthenticated calls are rejected', () => {
  it.each(nonPublic())('$path → UNAUTHORIZED', async ({ path }) => {
    const anon = f.browser();
    const err = await trpcError(anon.call((c) => invoke(c, path)));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('errors.auth.required');
  });

  it('a forged or unknown session cookie is the same as none', async () => {
    const anon = f.browser();
    anon.cookies.set('__Host-hmis_session', 'forged-token');
    const err = await trpcError(anon.call((c) => c.admin.listUsers()));
    expect(err.code).toBe('UNAUTHORIZED');
  });
});

describe('unauthorised calls are rejected', () => {
  let noRoles: TestBrowser;
  let reception: TestBrowser;

  beforeAll(async () => {
    noRoles = f.browser();
    await noRoles.login(f.users.noRoles.username);
    reception = f.browser();
    await reception.login(f.users.reception.username);
  });

  const permissioned = () => procedures.filter((p) => isPermission(p.rule));

  it.each(permissioned())('$path → FORBIDDEN for a user without roles', async ({ path }) => {
    const err = await trpcError(noRoles.call((c) => invoke(c, path)));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('errors.auth.forbidden');
  });

  it('reception is refused every procedure outside its bundle', async () => {
    const granted = new Set<string>(DEFAULT_ROLE_PERMISSIONS.reception);
    const refused = permissioned().filter((p) => !granted.has(p.rule as string));
    expect(refused.length).toBeGreaterThan(10);
    for (const { path } of refused) {
      const err = await trpcError(reception.call((c) => invoke(c, path)));
      expect(err.code, path).toBe('FORBIDDEN');
    }
  });
});

describe('session state gates', () => {
  it('a locked (idle) session reaches only logout, lock, unlock and me', async () => {
    const br = f.browser();
    await br.login(f.users.admin.username);
    br.clock.advance(11 * MINUTE);
    for (const { path, rule } of nonPublic()) {
      const allowed =
        !isPermission(rule) &&
        (ACCESS_RULES[rule as keyof typeof ACCESS_RULES] as readonly string[]).includes('locked');
      if (allowed) continue;
      const err = await trpcError(br.call((c) => invoke(c, path)));
      expect(err.message, path).toBe('errors.auth.locked');
    }
    const allowedPaths = nonPublic()
      .filter(
        (p) =>
          !isPermission(p.rule) &&
          (ACCESS_RULES[p.rule as keyof typeof ACCESS_RULES] as readonly string[]).includes(
            'locked',
          ),
      )
      .map((p) => p.path)
      .sort();
    expect(allowedPaths).toEqual([
      'auth.lock',
      'auth.logout',
      'auth.unlockWithPassword',
      'auth.unlockWithPin',
    ]);
  });

  it('a session waiting for TOTP reaches only verifyTotp and logout', async () => {
    const br = f.browser();
    await br.login(f.users.noPin.username);
    await f.db
      .update(session)
      .set({ mfaRequired: true })
      .where(eq(session.userId, f.users.noPin.id));
    for (const { path } of nonPublic()) {
      if (['auth.verifyTotp', 'auth.logout'].includes(path)) continue;
      const err = await trpcError(br.call((c) => invoke(c, path)));
      expect(err.message, path).toBe('errors.auth.mfaRequired');
    }
    expect(ruleOf('auth.verifyTotp')).toBe('session.mfa');
  });
});

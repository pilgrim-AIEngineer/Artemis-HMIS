import { loadUserAccess, readSettings, withTx, type Db } from '@hmis/db';
import { burnHash, verifySecret } from '@hmis/db/auth';
import { appUser, facility, session } from '@hmis/db/schema';
import { ipInCidrs, LOCALE_COOKIE, type SettingValue } from '@hmis/shared';
import { eq, sql } from 'drizzle-orm';
import { appError, setCookie, type Context } from '../trpc/init';
import { serializeCookie } from './cookies';
import { openSecret } from './secret-box';
import {
  clearSessionCookie,
  insertSession,
  resolveSession,
  revokeSession,
  sessionCookie,
  sessionTokenFromHeaders,
  workstationFromHeaders,
  type AuthSession,
} from './session';
import { verifyTotp } from './totp';

const LOGIN_SETTINGS = [
  'auth.sessionHours',
  'auth.maxLoginFailures',
  'auth.lockoutMinutes',
  'auth.totpRequiredRoles',
  'auth.lanNetworks',
] as const;

type LoginSettings = { [K in (typeof LOGIN_SETTINGS)[number]]: SettingValue<K> };

type UserRow = typeof appUser.$inferSelect;

const minutesLeft = (until: Date, now: Date) =>
  Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));

const lockedOut = (until: Date, now: Date) =>
  appError('TOO_MANY_REQUESTS', 'errors.auth.lockedOut', { minutes: minutesLeft(until, now) });

const isLocked = (until: Date | null, now: Date): until is Date =>
  until !== null && until.getTime() > now.getTime();

/**
 * Counts a wrong password/TOTP code in its own committed transaction (the caller then throws).
 * At `auth.maxLoginFailures` the account locks for `auth.lockoutMinutes` and the count restarts.
 * Returns the lock expiry when this failure locked the account.
 */
async function recordLoginFailure(
  db: Db,
  user: UserRow,
  settings: Pick<LoginSettings, 'auth.maxLoginFailures' | 'auth.lockoutMinutes'>,
  now: Date,
): Promise<Date | null> {
  return withTx({ db, userId: user.id, facilityId: user.facilityId }, async (tx) => {
    const [row] = await tx
      .update(appUser)
      .set({ failedLoginCount: sql`${appUser.failedLoginCount} + 1` })
      .where(eq(appUser.id, user.id))
      .returning({ count: appUser.failedLoginCount });
    if ((row?.count ?? 0) < settings['auth.maxLoginFailures']) return null;
    const until = new Date(now.getTime() + settings['auth.lockoutMinutes'] * 60_000);
    await tx
      .update(appUser)
      .set({ failedLoginCount: 0, lockedUntil: until })
      .where(eq(appUser.id, user.id));
    return until;
  });
}

async function findUserByUsername(db: Db, username: string) {
  const [row] = await db
    .select({ user: appUser, facilityActive: facility.isActive })
    .from(appUser)
    .innerJoin(facility, eq(facility.id, appUser.facilityId))
    .where(sql`lower(${appUser.username}) = lower(${username})`)
    .limit(1);
  return row;
}

export type LoginNext = 'totp' | 'change_password' | 'home';

/**
 * Username + password sign-in (docs/01 §5). The same error for unknown user, inactive user and
 * wrong password; lockout after `auth.maxLoginFailures`. Remote sign-ins (outside
 * `auth.lanNetworks`) of TOTP users create a session that is usable only after `verifyTotpLogin`.
 */
export async function login(
  ctx: Context,
  input: { username: string; password: string },
): Promise<{ next: LoginNext }> {
  const db = ctx.db();
  const now = ctx.now();
  const found = await findUserByUsername(db, input.username);
  if (!found || !found.user.isActive || !found.facilityActive) {
    await burnHash(input.password);
    throw appError('UNAUTHORIZED', 'errors.auth.invalidCredentials');
  }
  const user = found.user;
  const settings: LoginSettings = await readSettings(db, user.facilityId, LOGIN_SETTINGS);
  if (isLocked(user.lockedUntil, now)) {
    await burnHash(input.password);
    throw lockedOut(user.lockedUntil, now);
  }
  if (!(await verifySecret(user.passwordHash, input.password))) {
    const until = await recordLoginFailure(db, user, settings, now);
    if (until) throw lockedOut(until, now);
    throw appError('UNAUTHORIZED', 'errors.auth.invalidCredentials');
  }

  const isRemote = !ipInCidrs(ctx.clientIp, settings['auth.lanNetworks']);
  const { roles } = await loadUserAccess(db, user.id);
  const totpRoles: readonly string[] = settings['auth.totpRequiredRoles'];
  const roleNeedsTotp = roles.some((r) => totpRoles.includes(r));
  const totpEnabled = user.totpConfirmedAt !== null && user.totpSecretEnc !== null;
  const mfaRequired = isRemote && (roleNeedsTotp || totpEnabled);
  if (mfaRequired && !totpEnabled) {
    // Owner/admin without TOTP cannot sign in remotely; they enrol from the hospital LAN first.
    throw appError('FORBIDDEN', 'errors.auth.totpNotEnrolled');
  }

  const ws = await workstationFromHeaders(db, ctx.headers, user.facilityId);
  const previous = await resolveSession(db, sessionTokenFromHeaders(ctx.headers), now);
  const created = await withTx(
    { db, userId: user.id, facilityId: user.facilityId, workstationId: ws?.id ?? null },
    async (tx) => {
      if (previous) await revokeSession(tx, previous.sessionId, 'replaced', now);
      await tx
        .update(appUser)
        .set({
          failedLoginCount: 0,
          lockedUntil: null,
          ...(mfaRequired ? {} : { lastLoginAt: now }),
        })
        .where(eq(appUser.id, user.id));
      return insertSession(tx, {
        userId: user.id,
        facilityId: user.facilityId,
        workstationId: ws?.id ?? null,
        now,
        sessionHours: settings['auth.sessionHours'],
        mfaRequired,
        clientIp: ctx.clientIp,
        isRemote,
      });
    },
  );
  setCookie(ctx, sessionCookie(created.token, created.expiresAt, now));
  setCookie(ctx, localeCookie(user.preferredLocale));
  return {
    next: mfaRequired ? 'totp' : user.passwordMustChange ? 'change_password' : 'home',
  };
}

export const localeCookie = (locale: string) =>
  serializeCookie(LOCALE_COOKIE, locale, { httpOnly: false, maxAge: 365 * 24 * 3600 });

/** Second step of a remote sign-in. Wrong codes count towards the password lockout. */
export async function verifyTotpLogin(
  ctx: Context,
  auth: AuthSession,
  code: string,
): Promise<{ next: LoginNext }> {
  const db = ctx.db();
  const now = ctx.now();
  const [user] = await db.select().from(appUser).where(eq(appUser.id, auth.userId));
  if (!user?.totpSecretEnc) throw appError('FORBIDDEN', 'errors.auth.totpNotEnrolled');
  const settings = await readSettings(db, user.facilityId, [
    'auth.maxLoginFailures',
    'auth.lockoutMinutes',
  ]);
  if (isLocked(user.lockedUntil, now)) {
    await endSession(ctx, auth, 'lockout');
    throw lockedOut(user.lockedUntil, now);
  }
  const step = verifyTotp(openSecret(user.totpSecretEnc), code, now, user.totpLastStep);
  if (step === null) {
    const until = await recordLoginFailure(db, user, settings, now);
    if (until) {
      await endSession(ctx, auth, 'lockout');
      throw lockedOut(until, now);
    }
    throw appError('UNAUTHORIZED', 'errors.auth.totpInvalid');
  }
  await withTx(
    { db, userId: user.id, facilityId: user.facilityId, workstationId: auth.workstationId },
    async (tx) => {
      await tx
        .update(appUser)
        .set({ totpLastStep: step, failedLoginCount: 0, lastLoginAt: now })
        .where(eq(appUser.id, user.id));
      await tx
        .update(session)
        .set({ mfaVerifiedAt: now, lastSeenAt: now })
        .where(eq(session.id, auth.sessionId));
    },
  );
  return { next: user.passwordMustChange ? 'change_password' : 'home' };
}

/** Revokes the current session and clears its cookie. */
export async function endSession(ctx: Context, auth: AuthSession, reason: string): Promise<void> {
  const now = ctx.now();
  await withTx(
    {
      db: ctx.db(),
      userId: auth.userId,
      facilityId: auth.facilityId,
      workstationId: auth.workstationId,
    },
    (tx) => revokeSession(tx, auth.sessionId, reason, now),
  );
  setCookie(ctx, clearSessionCookie());
}

/**
 * PIN unlock of an idle-locked session for the same user (docs/03 §6). The PIN has its own
 * lockout: after `auth.maxPinFailures` wrong PINs the PIN is blocked for `auth.pinLockoutMinutes`
 * and the session ends, so the next step is a full password sign-in.
 */
export async function unlockWithPin(ctx: Context, auth: AuthSession, pin: string): Promise<void> {
  const db = ctx.db();
  const now = ctx.now();
  const [user] = await db.select().from(appUser).where(eq(appUser.id, auth.userId));
  if (!user) throw appError('UNAUTHORIZED', 'errors.auth.required');
  if (!user.pinHash) throw appError('BAD_REQUEST', 'errors.auth.pinNotSet');
  const settings = await readSettings(db, user.facilityId, [
    'auth.maxPinFailures',
    'auth.pinLockoutMinutes',
  ]);
  if (isLocked(user.pinLockedUntil, now)) {
    await endSession(ctx, auth, 'pin_lockout');
    throw appError('TOO_MANY_REQUESTS', 'errors.auth.pinLockedOut', {
      minutes: minutesLeft(user.pinLockedUntil, now),
    });
  }
  const actor = {
    db,
    userId: user.id,
    facilityId: user.facilityId,
    workstationId: auth.workstationId,
  };
  if (!(await verifySecret(user.pinHash, pin))) {
    const failures = user.pinFailedCount + 1;
    const max = settings['auth.maxPinFailures'];
    if (failures >= max) {
      const until = new Date(now.getTime() + settings['auth.pinLockoutMinutes'] * 60_000);
      await withTx(actor, (tx) =>
        tx
          .update(appUser)
          .set({ pinFailedCount: 0, pinLockedUntil: until })
          .where(eq(appUser.id, user.id)),
      );
      await endSession(ctx, auth, 'pin_lockout');
      throw appError('TOO_MANY_REQUESTS', 'errors.auth.pinLockedOut', {
        minutes: minutesLeft(until, now),
      });
    }
    await withTx(actor, (tx) =>
      tx.update(appUser).set({ pinFailedCount: failures }).where(eq(appUser.id, user.id)),
    );
    throw appError('UNAUTHORIZED', 'errors.auth.wrongPin', { remaining: max - failures });
  }
  await withTx(actor, async (tx) => {
    if (user.pinFailedCount !== 0 || user.pinLockedUntil) {
      await tx
        .update(appUser)
        .set({ pinFailedCount: 0, pinLockedUntil: null })
        .where(eq(appUser.id, user.id));
    }
    await tx
      .update(session)
      .set({ lockedAt: null, lastSeenAt: now })
      .where(eq(session.id, auth.sessionId));
  });
}

/**
 * Unlock with the password, for users who have not set a PIN yet. Uses the password lockout;
 * reaching it ends the session.
 */
export async function unlockWithPassword(
  ctx: Context,
  auth: AuthSession,
  password: string,
): Promise<void> {
  const db = ctx.db();
  const now = ctx.now();
  const [user] = await db.select().from(appUser).where(eq(appUser.id, auth.userId));
  if (!user) throw appError('UNAUTHORIZED', 'errors.auth.required');
  const settings = await readSettings(db, user.facilityId, [
    'auth.maxLoginFailures',
    'auth.lockoutMinutes',
  ]);
  if (isLocked(user.lockedUntil, now)) {
    await endSession(ctx, auth, 'lockout');
    throw lockedOut(user.lockedUntil, now);
  }
  if (!(await verifySecret(user.passwordHash, password))) {
    const until = await recordLoginFailure(db, user, settings, now);
    if (until) {
      await endSession(ctx, auth, 'lockout');
      throw lockedOut(until, now);
    }
    throw appError('UNAUTHORIZED', 'errors.auth.wrongPassword');
  }
  await withTx(
    { db, userId: user.id, facilityId: user.facilityId, workstationId: auth.workstationId },
    async (tx) => {
      if (user.failedLoginCount !== 0) {
        await tx.update(appUser).set({ failedLoginCount: 0 }).where(eq(appUser.id, user.id));
      }
      await tx
        .update(session)
        .set({ lockedAt: null, lastSeenAt: now })
        .where(eq(session.id, auth.sessionId));
    },
  );
}

/**
 * Confirms the signed-in user's current password for sensitive self-service changes (new
 * password, PIN, TOTP). Wrong answers count towards the lockout like a failed sign-in.
 */
export async function confirmPassword(
  ctx: Context,
  auth: AuthSession,
  password: string,
): Promise<UserRow> {
  const db = ctx.db();
  const now = ctx.now();
  const [user] = await db.select().from(appUser).where(eq(appUser.id, auth.userId));
  if (!user) throw appError('UNAUTHORIZED', 'errors.auth.required');
  if (!(await verifySecret(user.passwordHash, password))) {
    const settings = await readSettings(db, user.facilityId, [
      'auth.maxLoginFailures',
      'auth.lockoutMinutes',
    ]);
    const until = await recordLoginFailure(db, user, settings, now);
    if (until) {
      await endSession(ctx, auth, 'lockout');
      throw lockedOut(until, now);
    }
    throw appError('BAD_REQUEST', 'errors.auth.wrongPassword');
  }
  return user;
}

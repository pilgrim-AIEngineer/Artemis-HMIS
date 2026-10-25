import { loadUserAccess, readSettings, withTx, type Db, type Tx } from '@hmis/db';
import { appUser, facility, session, workstation } from '@hmis/db/schema';
import type { Locale, Permission } from '@hmis/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { SESSION_COOKIE, WORKSTATION_COOKIE } from '@/lib/auth-constants';
import { parseCookies, serializeCookie } from './cookies';
import { randomToken, safeEqual, sha256Hex } from './tokens';

/**
 * Session states (docs/01 §5, docs/03 §6), in precedence order:
 * - `mfa_pending`: remote sign-in of a TOTP user, code not yet entered;
 * - `password_change`: admin reset the password, a new one must be chosen first;
 * - `locked`: idle past `auth.idleLockMinutes` or locked explicitly; PIN (or password) unlocks;
 * - `active`.
 * Revoked or past `expires_at` (12 h absolute) means no session at all.
 */
export type SessionState = 'active' | 'locked' | 'mfa_pending' | 'password_change';

export interface AuthSession {
  sessionId: string;
  userId: string;
  facilityId: string;
  workstationId: string | null;
  workstationName: string | null;
  username: string;
  fullName: string;
  preferredLocale: Locale;
  hasPin: boolean;
  totpEnabled: boolean;
  roles: string[];
  permissions: ReadonlySet<Permission>;
  state: SessionState;
  isRemote: boolean;
  expiresAt: Date;
  lastSeenAt: Date;
  idleLockMinutes: number;
}

export const sessionTokenFromHeaders = (headers: Headers): string | null =>
  parseCookies(headers.get('cookie'))[SESSION_COOKIE] ?? null;

export function isIdle(lastSeenAt: Date, now: Date, idleLockMinutes: number): boolean {
  return now.getTime() - lastSeenAt.getTime() >= idleLockMinutes * 60_000;
}

/** Looks up the cookie's session and decides its state. Never throws for a bad/expired token. */
export async function resolveSession(
  db: Db,
  token: string | null,
  now: Date,
): Promise<AuthSession | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({
      s: session,
      user: {
        id: appUser.id,
        facilityId: appUser.facilityId,
        username: appUser.username,
        fullName: appUser.fullName,
        preferredLocale: appUser.preferredLocale,
        isActive: appUser.isActive,
        pinHash: appUser.pinHash,
        passwordMustChange: appUser.passwordMustChange,
        totpConfirmedAt: appUser.totpConfirmedAt,
      },
      facilityActive: facility.isActive,
      wsName: workstation.name,
      wsActive: workstation.isActive,
    })
    .from(session)
    .innerJoin(appUser, eq(appUser.id, session.userId))
    .innerJoin(facility, eq(facility.id, session.facilityId))
    .leftJoin(
      workstation,
      and(
        eq(workstation.id, session.workstationId),
        eq(workstation.facilityId, session.facilityId),
      ),
    )
    .where(eq(session.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!row) return null;
  const { s, user } = row;
  if (s.revokedAt || s.expiresAt.getTime() <= now.getTime()) return null;
  // Facility check: the session, its user and the facility must agree and be active.
  if (!user.isActive || user.facilityId !== s.facilityId || !row.facilityActive) return null;

  const settings = await readSettings(db, s.facilityId, ['auth.idleLockMinutes']);
  const idleLockMinutes = settings['auth.idleLockMinutes'];
  const access = await loadUserAccess(db, user.id);

  let state: SessionState = 'active';
  if (s.mfaRequired && !s.mfaVerifiedAt) state = 'mfa_pending';
  else if (user.passwordMustChange) state = 'password_change';
  else if (s.lockedAt || isIdle(s.lastSeenAt, now, idleLockMinutes)) state = 'locked';

  const wsOk = row.wsName !== null && row.wsActive === true;
  return {
    sessionId: s.id,
    userId: user.id,
    facilityId: s.facilityId,
    workstationId: wsOk ? s.workstationId : null,
    workstationName: wsOk ? row.wsName : null,
    username: user.username,
    fullName: user.fullName,
    preferredLocale: user.preferredLocale === 'hi' ? 'hi' : 'en',
    hasPin: user.pinHash !== null,
    totpEnabled: user.totpConfirmedAt !== null,
    roles: access.roles,
    permissions: new Set(access.permissions),
    state,
    isRemote: s.isRemote,
    expiresAt: s.expiresAt,
    lastSeenAt: s.lastSeenAt,
    idleLockMinutes,
  };
}

export interface NewSession {
  userId: string;
  facilityId: string;
  workstationId: string | null;
  now: Date;
  sessionHours: number;
  mfaRequired: boolean;
  clientIp: string | null;
  isRemote: boolean;
}

/** Inserts a session row; returns the raw token (only ever sent in the cookie). */
export async function insertSession(
  tx: Tx,
  s: NewSession,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken();
  const id = uuidv7();
  const expiresAt = new Date(s.now.getTime() + s.sessionHours * 3_600_000);
  await tx.insert(session).values({
    id,
    facilityId: s.facilityId,
    userId: s.userId,
    tokenHash: sha256Hex(token),
    workstationId: s.workstationId,
    lastSeenAt: s.now,
    expiresAt,
    mfaRequired: s.mfaRequired,
    clientIp: s.clientIp,
    isRemote: s.isRemote,
  });
  return { id, token, expiresAt };
}

export function sessionCookie(token: string, expiresAt: Date, now: Date): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
  });
}

export const clearSessionCookie = (): string => serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });

/** Revokes one session by id (no-op if already revoked). */
export async function revokeSession(tx: Tx, sessionId: string, reason: string, now: Date) {
  await tx
    .update(session)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(session.id, sessionId), isNull(session.revokedAt)));
}

/** Revokes every live session of a user (deactivation, password reset), optionally but one. */
export async function revokeUserSessions(
  tx: Tx,
  userId: string,
  reason: string,
  now: Date,
  exceptSessionId?: string,
) {
  const rows = await tx
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.userId, userId), isNull(session.revokedAt)));
  for (const r of rows) {
    if (r.id !== exceptSessionId) await revokeSession(tx, r.id, reason, now);
  }
}

/** Marks activity: resets the idle clock. Not audited (`last_seen_at` is an ignored column). */
export async function touchSession(db: Db, auth: AuthSession, now: Date): Promise<void> {
  await withTx(
    { db, userId: auth.userId, facilityId: auth.facilityId, workstationId: auth.workstationId },
    (tx) => tx.update(session).set({ lastSeenAt: now }).where(eq(session.id, auth.sessionId)),
  );
}

// --- Workstation pairing cookie (docs/01 §5) ---------------------------------------------

export const workstationCookie = (workstationId: string, secret: string): string =>
  serializeCookie(WORKSTATION_COOKIE, `${workstationId}.${secret}`, {
    maxAge: 10 * 365 * 24 * 3600,
  });

export const clearWorkstationCookie = (): string =>
  serializeCookie(WORKSTATION_COOKIE, '', { maxAge: 0 });

/**
 * The paired workstation of this browser, if the cookie's secret still matches the active
 * workstation in `facilityId` (re-pairing elsewhere or deactivation invalidates it).
 */
export async function workstationFromHeaders(
  db: Db | Tx,
  headers: Headers,
  facilityId: string,
): Promise<{ id: string; name: string } | null> {
  const raw = parseCookies(headers.get('cookie'))[WORKSTATION_COOKIE];
  const [id, secret] = raw?.split('.') ?? [];
  if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [ws] = await db
    .select({ id: workstation.id, name: workstation.name, hash: workstation.pairingTokenHash })
    .from(workstation)
    .where(
      and(
        eq(workstation.id, id),
        eq(workstation.facilityId, facilityId),
        eq(workstation.isActive, true),
      ),
    );
  if (!ws?.hash || !safeEqual(ws.hash, sha256Hex(secret))) return null;
  return { id: ws.id, name: ws.name };
}

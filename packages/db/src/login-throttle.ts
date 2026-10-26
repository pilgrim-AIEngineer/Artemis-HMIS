/**
 * Sign-in throttling (D-17, issue #96). Failures are throttled per (user, source IP) so one
 * attacker cannot lock a user out for everybody, plus per source IP across users, plus a
 * username-wide lock that needs many failures from several IPs and never applies to owners.
 * Supervisor-PIN failures use their own (approver, requester) counter and never touch sign-in.
 * Lock events go to `access_log`; no credential is ever written.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { accessLog, appUser, loginFailure } from '../schema';
import type { Db } from './client';
import type { Tx } from './tx';

export const IP_FAILURE_LIMIT = 20;
export const IP_WINDOW_MINUTES = 15;
export const ACCOUNT_FAILURE_LIMIT = 20;
export const ACCOUNT_MIN_DISTINCT_IPS = 3;
export const ACCOUNT_WINDOW_MINUTES = 60;
export const MAX_PAIR_LOCK_MINUTES = 240;
/** Earlier locks of a pair only escalate the next one for this long. */
const ESCALATION_WINDOW_HOURS = 24;

const MIN = 60_000;
export const normaliseIp = (ip: string | null | undefined) => ip || 'unknown';

type Executor = Db | Tx;
const SIGN_IN_KINDS = ['password', 'totp'] as const;

export interface ThrottleUser {
  id: string;
  facilityId: string;
  lockedUntil: Date | null;
}

/** The moment a sign-in from `ip` is allowed again, or null when it is not throttled. */
export async function signInBlockedUntil(
  db: Executor,
  user: ThrottleUser,
  ip: string | null,
  isOwner: boolean,
  now: Date,
): Promise<Date | null> {
  const ipKey = normaliseIp(ip);
  const windowStart = new Date(now.getTime() - IP_WINDOW_MINUTES * MIN);
  const [ipEdge] = await db
    .select({ at: loginFailure.at })
    .from(loginFailure)
    .where(
      and(
        eq(loginFailure.facilityId, user.facilityId),
        eq(loginFailure.clientIp, ipKey),
        inArray(loginFailure.kind, SIGN_IN_KINDS),
        isNull(loginFailure.clearedAt),
        gt(loginFailure.at, windowStart),
      ),
    )
    .orderBy(desc(loginFailure.at))
    .offset(IP_FAILURE_LIMIT - 1)
    .limit(1);
  const candidates: Date[] = [];
  if (ipEdge) candidates.push(new Date(ipEdge.at.getTime() + IP_WINDOW_MINUTES * MIN));
  const [pair] = await db
    .select({ until: sql<Date | null>`max(${loginFailure.lockUntil})` })
    .from(loginFailure)
    .where(
      and(
        eq(loginFailure.userId, user.id),
        eq(loginFailure.clientIp, ipKey),
        inArray(loginFailure.kind, SIGN_IN_KINDS),
        isNull(loginFailure.clearedAt),
      ),
    );
  if (pair?.until) candidates.push(new Date(pair.until));
  if (!isOwner && user.lockedUntil) candidates.push(user.lockedUntil);
  const active = candidates.filter((d) => d.getTime() > now.getTime());
  return active.length ? new Date(Math.max(...active.map((d) => d.getTime()))) : null;
}

async function audit(tx: Tx, user: ThrottleUser, purpose: string, now: Date) {
  await tx.insert(accessLog).values({
    id: uuidv7(),
    facilityId: user.facilityId,
    userId: user.id,
    entity: 'login_throttle',
    entityId: user.id,
    purpose,
    at: now,
  });
}

export interface FailureLimits {
  maxFailures: number;
  lockoutMinutes: number;
}

/**
 * Records a wrong password/TOTP code (own committed transaction in the caller's `tx`). Returns
 * when the (user, IP) pair or, for non-owners, the username is now locked until.
 */
export async function recordSignInFailure(
  tx: Tx,
  user: ThrottleUser,
  input: { ip: string | null; kind: 'password' | 'totp'; isOwner: boolean },
  limits: FailureLimits,
  now: Date,
): Promise<Date | null> {
  const ipKey = normaliseIp(input.ip);
  // Row lock: concurrent guesses are counted one after another.
  await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, user.id)).for('update');
  const eventId = uuidv7();
  await tx.insert(loginFailure).values({
    id: eventId,
    facilityId: user.facilityId,
    userId: user.id,
    clientIp: ipKey,
    kind: input.kind,
    at: now,
  });
  const pair = and(
    eq(loginFailure.userId, user.id),
    eq(loginFailure.clientIp, ipKey),
    inArray(loginFailure.kind, SIGN_IN_KINDS),
    isNull(loginFailure.clearedAt),
  );
  const [lastLock] = await tx
    .select({ at: loginFailure.at })
    .from(loginFailure)
    .where(and(pair, isNotNull(loginFailure.lockUntil)))
    .orderBy(desc(loginFailure.at))
    .limit(1);
  const [since] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(loginFailure)
    .where(and(pair, lastLock ? gt(loginFailure.at, lastLock.at) : undefined));
  let result: Date | null = null;
  if ((since?.n ?? 0) >= limits.maxFailures) {
    const [prior] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(loginFailure)
      .where(
        and(
          pair,
          isNotNull(loginFailure.lockUntil),
          gt(loginFailure.at, new Date(now.getTime() - ESCALATION_WINDOW_HOURS * 60 * MIN)),
        ),
      );
    const minutes = Math.min(
      limits.lockoutMinutes * 2 ** Math.min(prior?.n ?? 0, 10),
      MAX_PAIR_LOCK_MINUTES,
    );
    result = new Date(now.getTime() + minutes * MIN);
    await tx.update(loginFailure).set({ lockUntil: result }).where(eq(loginFailure.id, eventId));
    await audit(tx, user, `pair_lock:${minutes}min`, now);
  }
  if (!input.isOwner) {
    const [acc] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        ips: sql<number>`count(distinct ${loginFailure.clientIp})::int`,
      })
      .from(loginFailure)
      .where(
        and(
          eq(loginFailure.userId, user.id),
          inArray(loginFailure.kind, SIGN_IN_KINDS),
          isNull(loginFailure.clearedAt),
          gt(loginFailure.at, new Date(now.getTime() - ACCOUNT_WINDOW_MINUTES * MIN)),
        ),
      );
    if (
      (acc?.n ?? 0) >= ACCOUNT_FAILURE_LIMIT &&
      (acc?.ips ?? 0) >= ACCOUNT_MIN_DISTINCT_IPS &&
      !(user.lockedUntil && user.lockedUntil.getTime() > now.getTime())
    ) {
      const until = new Date(now.getTime() + limits.lockoutMinutes * MIN);
      await tx.update(appUser).set({ lockedUntil: until }).where(eq(appUser.id, user.id));
      await audit(tx, user, 'account_lock', now);
      result = result && result.getTime() > until.getTime() ? result : until;
    }
  }
  return result;
}

/** A correct password for this source: its pair history no longer counts. */
export async function clearPairFailures(tx: Tx, userId: string, ip: string | null, now: Date) {
  await tx
    .update(loginFailure)
    .set({ clearedAt: now })
    .where(
      and(
        eq(loginFailure.userId, userId),
        eq(loginFailure.clientIp, normaliseIp(ip)),
        inArray(loginFailure.kind, SIGN_IN_KINDS),
        isNull(loginFailure.clearedAt),
      ),
    );
}

/** Admin/CLI unlock: every throttle record and the username-wide lock of the user. */
export async function clearAllThrottles(tx: Tx, userId: string, now: Date) {
  await tx
    .update(loginFailure)
    .set({ clearedAt: now })
    .where(and(eq(loginFailure.userId, userId), isNull(loginFailure.clearedAt)));
  await tx
    .update(appUser)
    .set({ failedLoginCount: 0, lockedUntil: null, pinFailedCount: 0, pinLockedUntil: null })
    .where(eq(appUser.id, userId));
}

/** Supervisor approval PIN: its own counter per (approver, requester). */
export async function approvalPinBlockedUntil(
  db: Executor,
  approverId: string,
  requesterId: string,
  now: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ until: sql<Date | null>`max(${loginFailure.lockUntil})` })
    .from(loginFailure)
    .where(
      and(
        eq(loginFailure.userId, approverId),
        eq(loginFailure.actorUserId, requesterId),
        eq(loginFailure.kind, 'approval_pin'),
        isNull(loginFailure.clearedAt),
      ),
    );
  const until = row?.until ? new Date(row.until) : null;
  return until && until.getTime() > now.getTime() ? until : null;
}

export async function recordApprovalPinFailure(
  tx: Tx,
  approver: ThrottleUser,
  requesterId: string,
  limits: FailureLimits,
  now: Date,
): Promise<void> {
  await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(eq(appUser.id, approver.id))
    .for('update');
  const eventId = uuidv7();
  await tx.insert(loginFailure).values({
    id: eventId,
    facilityId: approver.facilityId,
    userId: approver.id,
    clientIp: 'approval',
    kind: 'approval_pin',
    actorUserId: requesterId,
    at: now,
  });
  const pair = and(
    eq(loginFailure.userId, approver.id),
    eq(loginFailure.actorUserId, requesterId),
    eq(loginFailure.kind, 'approval_pin'),
    isNull(loginFailure.clearedAt),
  );
  const [lastLock] = await tx
    .select({ at: loginFailure.at })
    .from(loginFailure)
    .where(and(pair, isNotNull(loginFailure.lockUntil)))
    .orderBy(desc(loginFailure.at))
    .limit(1);
  const [since] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(loginFailure)
    .where(and(pair, lastLock ? gt(loginFailure.at, lastLock.at) : undefined));
  if ((since?.n ?? 0) >= limits.maxFailures) {
    await tx
      .update(loginFailure)
      .set({ lockUntil: new Date(now.getTime() + limits.lockoutMinutes * MIN) })
      .where(eq(loginFailure.id, eventId));
    await audit(tx, approver, 'approval_pin_lock', now);
  }
}

export async function clearApprovalPinFailures(
  tx: Tx,
  approverId: string,
  requesterId: string,
  now: Date,
) {
  await tx
    .update(loginFailure)
    .set({ clearedAt: now })
    .where(
      and(
        eq(loginFailure.userId, approverId),
        eq(loginFailure.actorUserId, requesterId),
        eq(loginFailure.kind, 'approval_pin'),
        isNull(loginFailure.clearedAt),
      ),
    );
}

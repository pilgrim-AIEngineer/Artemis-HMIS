/**
 * Supervisor approval by PIN (docs/03 §4, BIL-03, BIL-04). The approver types their username and
 * PIN on the requester's screen; this checks them *before* the money transaction and in a
 * transaction of its own, so a wrong PIN still counts towards the approver's PIN lockout when the
 * money transaction is rolled back. The PIN lockout is the one of the approver's own account
 * (`auth.maxPinFailures`, `auth.pinLockoutMinutes`). Neither the PIN nor the username reach an
 * idempotency payload, a log line or an error message (AGENTS.md rule 15).
 */
import { APPROVER_PERMISSION } from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { appUser } from '../schema';
import type { Db } from './client';
import { burnHash, verifySecret } from './password';
import { loadUserAccess } from './rbac';
import { readSettings } from './settings';
import { withTx } from './tx';

export type ApprovalErrorKey =
  'approval.invalid' | 'approval.locked' | 'approval.notAuthorised' | 'approval.selfNotAllowed';

export class ApprovalError extends Error {
  constructor(
    readonly key: ApprovalErrorKey,
    readonly params?: Record<string, number>,
  ) {
    super(key);
    this.name = 'ApprovalError';
  }
}

export interface VerifyApproverInput {
  facilityId: string;
  requesterId: string;
  username: string;
  pin: string;
}

/**
 * Returns the approver's user id when `username` + `pin` belong to an active user of the facility
 * who holds `billing.discount.approve` and is not the requester. An unknown user, a user without
 * a PIN and a wrong PIN all answer `approval.invalid`, after the same amount of work.
 */
export async function verifyApproverPin(
  db: Db,
  input: VerifyApproverInput,
  now: Date,
): Promise<string> {
  const [user] = await db
    .select()
    .from(appUser)
    .where(
      and(
        eq(appUser.facilityId, input.facilityId),
        sql`lower(${appUser.username}) = lower(${input.username})`,
        eq(appUser.isActive, true),
      ),
    );
  if (!user || user.deactivatedAt) {
    await burnHash(input.pin);
    throw new ApprovalError('approval.invalid');
  }
  if (user.pinLockedUntil && user.pinLockedUntil.getTime() > now.getTime()) {
    throw new ApprovalError('approval.locked', {
      minutes: Math.max(1, Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / 60_000)),
    });
  }
  const actor = { db, userId: input.requesterId, facilityId: input.facilityId };
  if (!(await verifySecret(user.pinHash, input.pin))) {
    const cfg = await readSettings(db, input.facilityId, [
      'auth.maxPinFailures',
      'auth.pinLockoutMinutes',
    ]);
    const until = new Date(now.getTime() + cfg['auth.pinLockoutMinutes'] * 60_000);
    // Atomic increment under the row lock: concurrent guesses cannot share a stale count.
    await withTx(actor, async (tx) => {
      const [row] = await tx
        .update(appUser)
        .set({ pinFailedCount: sql`${appUser.pinFailedCount} + 1` })
        .where(eq(appUser.id, user.id))
        .returning({ count: appUser.pinFailedCount });
      if ((row?.count ?? 1) >= cfg['auth.maxPinFailures']) {
        await tx
          .update(appUser)
          .set({ pinFailedCount: 0, pinLockedUntil: until })
          .where(eq(appUser.id, user.id));
      }
    });
    throw new ApprovalError('approval.invalid');
  }
  if (user.pinFailedCount !== 0 || user.pinLockedUntil) {
    await withTx(actor, (tx) =>
      tx
        .update(appUser)
        .set({ pinFailedCount: 0, pinLockedUntil: null })
        .where(eq(appUser.id, user.id)),
    );
  }
  if (user.id === input.requesterId) throw new ApprovalError('approval.selfNotAllowed');
  const access = await loadUserAccess(db, user.id);
  if (!access.permissions.includes(APPROVER_PERMISSION)) {
    throw new ApprovalError('approval.notAuthorised');
  }
  return user.id;
}

import { hashSecret } from '@hmis/db/auth';
import { appUser, role, session, userRole, workstation } from '@hmis/db/schema';
import {
  fullNameSchema,
  optionalMobileSchema,
  passwordSchema,
  reasonSchema,
  userLocaleSchema,
  usernameSchema,
  uuidSchema,
} from '@hmis/shared';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { revokeSession, revokeUserSessions } from '../../../auth/session';
import { appError, protectedProcedure, type Context } from '../../init';
import type { AuthSession } from '../../../auth/session';
import type { Tx } from '@hmis/db';
import { clearAllThrottles } from '@hmis/db/login-throttle';
import { assertMayChangeRoles, assertMayManageUser, assertUserManagerRemains } from './guards';

const manage = protectedProcedure.meta({ permission: 'admin.users.manage' });

const userIdInput = z.object({ userId: uuidSchema });

/** The user if it belongs to the caller's facility; otherwise NOT_FOUND (cross-facility). */
async function userInFacility(tx: Tx, facilityId: string, userId: string) {
  const [u] = await tx
    .select()
    .from(appUser)
    .where(and(eq(appUser.id, userId), eq(appUser.facilityId, facilityId)));
  if (!u) throw appError('NOT_FOUND', 'errors.notFound');
  return u;
}

/** Active role ids of the facility among `roleIds`; any unknown/inactive/foreign id → NOT_FOUND. */
async function rolesInFacility(tx: Tx, facilityId: string, roleIds: readonly string[]) {
  if (roleIds.length === 0) return [];
  const rows = await tx
    .select({ id: role.id })
    .from(role)
    .where(
      and(inArray(role.id, [...roleIds]), eq(role.facilityId, facilityId), eq(role.isActive, true)),
    );
  if (rows.length !== new Set(roleIds).size) throw appError('NOT_FOUND', 'errors.notFound');
  return rows.map((r) => r.id);
}

async function setRoles(
  tx: Tx,
  auth: AuthSession,
  userId: string,
  roleIds: readonly string[],
  now: Date,
) {
  const wanted = new Set(await rolesInFacility(tx, auth.facilityId, roleIds));
  const current = await tx
    .select({ id: userRole.id, roleId: userRole.roleId })
    .from(userRole)
    .where(and(eq(userRole.userId, userId), isNull(userRole.revokedAt)));
  const have = new Set(current.map((c) => c.roleId));
  const add = [...wanted].filter((r) => !have.has(r));
  const removed = current.filter((c) => !wanted.has(c.roleId));
  await assertMayChangeRoles(
    tx,
    auth,
    add,
    removed.map((c) => c.roleId),
  );
  for (const c of removed) {
    await tx
      .update(userRole)
      .set({ revokedAt: now, revokedBy: auth.userId })
      .where(eq(userRole.id, c.id));
  }
  if (add.length > 0) {
    await tx
      .insert(userRole)
      .values(add.map((roleId) => ({ id: uuidv7(), facilityId: auth.facilityId, userId, roleId })));
  }
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === '23505';
};

const now = (ctx: Context) => ctx.now();

export const userProcedures = {
  listUsers: manage
    .input(z.object({ search: z.string().trim().max(60).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const t = now(ctx);
      const q = input?.search ? `%${input.search.toLowerCase()}%` : null;
      const users = await ctx
        .db()
        .select({
          id: appUser.id,
          username: appUser.username,
          fullName: appUser.fullName,
          mobile: appUser.mobile,
          preferredLocale: appUser.preferredLocale,
          isActive: appUser.isActive,
          lastLoginAt: appUser.lastLoginAt,
          lockedUntil: appUser.lockedUntil,
          pinLockedUntil: appUser.pinLockedUntil,
          hasPin: sql<boolean>`${appUser.pinHash} is not null`,
          totpEnabled: sql<boolean>`${appUser.totpConfirmedAt} is not null`,
          passwordMustChange: appUser.passwordMustChange,
        })
        .from(appUser)
        .where(
          and(
            eq(appUser.facilityId, ctx.auth.facilityId),
            q
              ? sql`(lower(${appUser.username}) like ${q} or lower(${appUser.fullName}) like ${q})`
              : undefined,
          ),
        )
        .orderBy(desc(appUser.isActive), asc(appUser.fullName));
      const roleRows = users.length
        ? await ctx
            .db()
            .select({
              userId: userRole.userId,
              roleId: role.id,
              key: role.key,
              name: role.name,
              nameHi: role.nameHi,
            })
            .from(userRole)
            .innerJoin(role, eq(role.id, userRole.roleId))
            .where(
              and(
                inArray(
                  userRole.userId,
                  users.map((u) => u.id),
                ),
                isNull(userRole.revokedAt),
                eq(role.facilityId, ctx.auth.facilityId),
              ),
            )
        : [];
      return users.map((u) => ({
        ...u,
        isLockedOut: (u.lockedUntil?.getTime() ?? 0) > t.getTime(),
        isPinLockedOut: (u.pinLockedUntil?.getTime() ?? 0) > t.getTime(),
        roles: roleRows
          .filter((r) => r.userId === u.id)
          .map(({ roleId, key, name, nameHi }) => ({ id: roleId, key, name, nameHi })),
      }));
    }),

  createUser: manage
    .input(
      z.object({
        username: usernameSchema,
        fullName: fullNameSchema,
        mobile: optionalMobileSchema,
        preferredLocale: userLocaleSchema,
        roleIds: z.array(uuidSchema).max(20),
        /** Temporary password, told to the user in person; they must change it at first sign-in. */
        password: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const passwordHash = await hashSecret(input.password);
      const id = uuidv7();
      try {
        await ctx.tx(async (tx) => {
          await tx.insert(appUser).values({
            id,
            facilityId: ctx.auth.facilityId,
            username: input.username,
            fullName: input.fullName,
            mobile: input.mobile,
            preferredLocale: input.preferredLocale,
            passwordHash,
            passwordMustChange: true,
          });
          await setRoles(tx, ctx.auth, id, input.roleIds, now(ctx));
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw appError('CONFLICT', 'errors.admin.usernameTaken');
        throw err;
      }
      return { id };
    }),

  updateUser: manage
    .input(
      userIdInput.extend({
        fullName: fullNameSchema,
        mobile: optionalMobileSchema,
        preferredLocale: userLocaleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.tx(async (tx) => {
        await userInFacility(tx, ctx.auth.facilityId, input.userId);
        await tx
          .update(appUser)
          .set({
            fullName: input.fullName,
            mobile: input.mobile,
            preferredLocale: input.preferredLocale,
          })
          .where(eq(appUser.id, input.userId));
      });
      return { ok: true as const };
    }),

  setUserRoles: manage
    .input(userIdInput.extend({ roleIds: z.array(uuidSchema).max(20) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.tx(async (tx) => {
        await userInFacility(tx, ctx.auth.facilityId, input.userId);
        await setRoles(tx, ctx.auth, input.userId, input.roleIds, now(ctx));
        await assertUserManagerRemains(tx, ctx.auth.facilityId);
      });
      return { ok: true as const };
    }),

  /** No hard delete (AGENTS.md rule 4): the account is switched off and its sessions end. */
  deactivateUser: manage
    .input(userIdInput.extend({ reason: reasonSchema }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.auth.userId)
        throw appError('BAD_REQUEST', 'errors.admin.cannotDeactivateSelf');
      const t = now(ctx);
      await ctx.tx(async (tx) => {
        const u = await userInFacility(tx, ctx.auth.facilityId, input.userId);
        await assertMayManageUser(tx, ctx.auth, u.id);
        if (!u.isActive) return;
        await tx
          .update(appUser)
          .set({
            isActive: false,
            deactivatedAt: t,
            deactivatedBy: ctx.auth.userId,
            deactivateReason: input.reason,
          })
          .where(eq(appUser.id, u.id));
        await revokeUserSessions(tx, u.id, 'deactivated', t);
        await assertUserManagerRemains(tx, ctx.auth.facilityId);
      });
      return { ok: true as const };
    }),

  reactivateUser: manage.input(userIdInput).mutation(async ({ ctx, input }) => {
    await ctx.tx(async (tx) => {
      const u = await userInFacility(tx, ctx.auth.facilityId, input.userId);
      await assertMayManageUser(tx, ctx.auth, u.id);
      if (u.isActive) return;
      await tx
        .update(appUser)
        .set({ isActive: true, deactivatedAt: null, deactivatedBy: null, deactivateReason: null })
        .where(eq(appUser.id, u.id));
    });
    return { ok: true as const };
  }),

  /** Admin password reset: temporary password, change forced at next sign-in, sessions end. */
  resetPassword: manage
    .input(userIdInput.extend({ password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const passwordHash = await hashSecret(input.password);
      const t = now(ctx);
      await ctx.tx(async (tx) => {
        const u = await userInFacility(tx, ctx.auth.facilityId, input.userId);
        await assertMayManageUser(tx, ctx.auth, u.id);
        await tx
          .update(appUser)
          .set({ passwordHash, passwordMustChange: true, failedLoginCount: 0, lockedUntil: null })
          .where(eq(appUser.id, u.id));
        await clearAllThrottles(tx, u.id, t);
        await revokeUserSessions(tx, u.id, 'password_reset', t, ctx.auth.sessionId);
      });
      return { ok: true as const };
    }),

  /** Clears the PIN (and its lockout); the user sets a new one after the next sign-in. */
  resetPin: manage.input(userIdInput).mutation(async ({ ctx, input }) => {
    await ctx.tx(async (tx) => {
      const u = await userInFacility(tx, ctx.auth.facilityId, input.userId);
      await assertMayManageUser(tx, ctx.auth, u.id);
      await tx
        .update(appUser)
        .set({ pinHash: null, pinFailedCount: 0, pinLockedUntil: null })
        .where(eq(appUser.id, u.id));
    });
    return { ok: true as const };
  }),

  /** Lifts password and PIN lockouts early (the user is standing at the desk). */
  clearLockout: manage.input(userIdInput).mutation(async ({ ctx, input }) => {
    await ctx.tx(async (tx) => {
      const u = await userInFacility(tx, ctx.auth.facilityId, input.userId);
      await assertMayManageUser(tx, ctx.auth, u.id);
      await tx
        .update(appUser)
        .set({ failedLoginCount: 0, lockedUntil: null, pinFailedCount: 0, pinLockedUntil: null })
        .where(eq(appUser.id, u.id));
      await clearAllThrottles(tx, u.id, now(ctx));
    });
    return { ok: true as const };
  }),

  /** Lost phone: TOTP off; the user re-enrols from the hospital LAN. Remote sessions end. */
  resetTotp: manage.input(userIdInput).mutation(async ({ ctx, input }) => {
    const t = now(ctx);
    await ctx.tx(async (tx) => {
      const u = await userInFacility(tx, ctx.auth.facilityId, input.userId);
      await assertMayManageUser(tx, ctx.auth, u.id);
      await tx
        .update(appUser)
        .set({ totpSecretEnc: null, totpConfirmedAt: null, totpLastStep: null })
        .where(eq(appUser.id, u.id));
      const remote = await tx
        .select({ id: session.id })
        .from(session)
        .where(
          and(eq(session.userId, u.id), isNull(session.revokedAt), eq(session.isRemote, true)),
        );
      for (const s of remote) await revokeSession(tx, s.id, 'totp_reset', t);
    });
    return { ok: true as const };
  }),

  /** Live sessions in the facility (docs/03 §6: admin can see and revoke them). */
  listSessions: manage
    .input(z.object({ userId: uuidSchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const t = now(ctx);
      return ctx
        .db()
        .select({
          id: session.id,
          userId: session.userId,
          username: appUser.username,
          fullName: appUser.fullName,
          workstationName: workstation.name,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          isRemote: session.isRemote,
          clientIp: session.clientIp,
        })
        .from(session)
        .innerJoin(appUser, eq(appUser.id, session.userId))
        .leftJoin(workstation, eq(workstation.id, session.workstationId))
        .where(
          and(
            eq(session.facilityId, ctx.auth.facilityId),
            isNull(session.revokedAt),
            gt(session.expiresAt, t),
            input?.userId ? eq(session.userId, input.userId) : undefined,
          ),
        )
        .orderBy(desc(session.lastSeenAt));
    }),

  revokeSession: manage
    .input(z.object({ sessionId: uuidSchema }))
    .mutation(async ({ ctx, input }) => {
      await ctx.tx(async (tx) => {
        const [s] = await tx
          .select({ id: session.id })
          .from(session)
          .where(and(eq(session.id, input.sessionId), eq(session.facilityId, ctx.auth.facilityId)));
        if (!s) throw appError('NOT_FOUND', 'errors.notFound');
        await revokeSession(tx, s.id, 'admin_revoked', now(ctx));
      });
      return { ok: true as const };
    }),
};

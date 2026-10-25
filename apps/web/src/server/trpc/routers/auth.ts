import { hashSecret, readSettings } from '@hmis/db';
import { appUser, session } from '@hmis/db/schema';
import {
  loginPasswordSchema,
  passwordSchema,
  pinEntrySchema,
  pinSchema,
  totpCodeSchema,
  userLocaleSchema,
  usernameSchema,
} from '@hmis/shared';
import { eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  confirmPassword,
  endSession,
  localeCookie,
  login,
  unlockWithPassword,
  unlockWithPin,
  verifyTotpLogin,
} from '../../auth/service';
import { hasSecretKey, openSecret, sealSecret } from '../../auth/secret-box';
import {
  resolveSession,
  revokeUserSessions,
  sessionTokenFromHeaders,
  type AuthSession,
} from '../../auth/session';
import { generateTotpSecret, totpUri, verifyTotp } from '../../auth/totp';
import { appError, protectedProcedure, publicProcedure, router, setCookie } from '../init';

/** What the browser needs about its own session (lock screen, menus, idle timer). */
function meView(auth: AuthSession, totpRequired: boolean) {
  return {
    userId: auth.userId,
    username: auth.username,
    fullName: auth.fullName,
    preferredLocale: auth.preferredLocale,
    state: auth.state,
    roles: auth.roles,
    permissions: [...auth.permissions].sort(),
    hasPin: auth.hasPin,
    totpEnabled: auth.totpEnabled,
    /** True when this user's roles require TOTP for remote sign-in (setting). */
    totpRequired,
    isRemote: auth.isRemote,
    workstationName: auth.workstationName,
    idleLockMinutes: auth.idleLockMinutes,
    expiresAt: auth.expiresAt,
  };
}

export type MeView = ReturnType<typeof meView>;

export const authRouter = router({
  /** The caller's session, or null when signed out. Reveals nothing about other users. */
  me: publicProcedure.meta({ permission: 'public' }).query(async ({ ctx }) => {
    const auth = await resolveSession(ctx.db(), sessionTokenFromHeaders(ctx.headers), ctx.now());
    if (!auth) return null;
    const s = await readSettings(ctx.db(), auth.facilityId, ['auth.totpRequiredRoles']);
    const required = s['auth.totpRequiredRoles'].some((r) => auth.roles.includes(r));
    return meView(auth, required);
  }),

  login: publicProcedure
    .meta({ permission: 'public' })
    .input(z.object({ username: usernameSchema, password: loginPasswordSchema }))
    .mutation(({ ctx, input }) => login(ctx, input)),

  verifyTotp: protectedProcedure
    .meta({ permission: 'session.mfa' })
    .input(z.object({ code: totpCodeSchema }))
    .mutation(({ ctx, input }) => verifyTotpLogin(ctx, ctx.auth, input.code)),

  /** Sign out ("Switch user" too). Allowed in every session state. */
  logout: protectedProcedure.meta({ permission: 'session.any' }).mutation(async ({ ctx }) => {
    await endSession(ctx, ctx.auth, 'logout');
    return { ok: true as const };
  }),

  /** Activity ping from the client's idle tracker; the access middleware resets the idle clock. */
  heartbeat: protectedProcedure.meta({ permission: 'session' }).mutation(({ ctx }) => ({
    idleLockMinutes: ctx.auth.idleLockMinutes,
    expiresAt: ctx.auth.expiresAt,
  })),

  /** "Lock" button / client idle timer. */
  lock: protectedProcedure.meta({ permission: 'session.unlock' }).mutation(async ({ ctx }) => {
    const now = ctx.now();
    await ctx.tx((tx) =>
      tx.update(session).set({ lockedAt: now }).where(eq(session.id, ctx.auth.sessionId)),
    );
    return { ok: true as const };
  }),

  unlockWithPin: protectedProcedure
    .meta({ permission: 'session.unlock' })
    .input(z.object({ pin: pinEntrySchema }))
    .mutation(async ({ ctx, input }) => {
      await unlockWithPin(ctx, ctx.auth, input.pin);
      return { ok: true as const };
    }),

  /** For users without a PIN yet. */
  unlockWithPassword: protectedProcedure
    .meta({ permission: 'session.unlock' })
    .input(z.object({ password: loginPasswordSchema }))
    .mutation(async ({ ctx, input }) => {
      await unlockWithPassword(ctx, ctx.auth, input.password);
      return { ok: true as const };
    }),

  /** Own password; also the forced change after an admin reset. Ends the user's other sessions. */
  changePassword: protectedProcedure
    .meta({ permission: 'session.password' })
    .input(z.object({ currentPassword: loginPasswordSchema, newPassword: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      await confirmPassword(ctx, ctx.auth, input.currentPassword);
      if (input.currentPassword === input.newPassword) {
        throw appError('BAD_REQUEST', 'errors.auth.passwordReused');
      }
      const now = ctx.now();
      const passwordHash = await hashSecret(input.newPassword);
      await ctx.tx(async (tx) => {
        await tx
          .update(appUser)
          .set({ passwordHash, passwordMustChange: false, passwordChangedAt: now })
          .where(eq(appUser.id, ctx.auth.userId));
        await revokeUserSessions(tx, ctx.auth.userId, 'password_changed', now, ctx.auth.sessionId);
      });
      return { ok: true as const };
    }),

  /** Own PIN (4–6 digits). Needs the password, because the PIN also approves discounts. */
  setPin: protectedProcedure
    .meta({ permission: 'session' })
    .input(z.object({ currentPassword: loginPasswordSchema, pin: pinSchema }))
    .mutation(async ({ ctx, input }) => {
      await confirmPassword(ctx, ctx.auth, input.currentPassword);
      const pinHash = await hashSecret(input.pin);
      await ctx.tx((tx) =>
        tx
          .update(appUser)
          .set({ pinHash, pinFailedCount: 0, pinLockedUntil: null })
          .where(eq(appUser.id, ctx.auth.userId)),
      );
      return { ok: true as const };
    }),

  setLanguage: protectedProcedure
    .meta({ permission: 'session' })
    .input(z.object({ locale: userLocaleSchema }))
    .mutation(async ({ ctx, input }) => {
      await ctx.tx((tx) =>
        tx
          .update(appUser)
          .set({ preferredLocale: input.locale })
          .where(eq(appUser.id, ctx.auth.userId)),
      );
      setCookie(ctx, localeCookie(input.locale));
      return { ok: true as const };
    }),

  /**
   * Step 1 of TOTP enrolment: a new secret, stored sealed but not enforced until confirmed.
   * Re-enrolling replaces an existing secret only after the password check.
   */
  startTotpEnrolment: protectedProcedure
    .meta({ permission: 'session' })
    .input(z.object({ currentPassword: loginPasswordSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!hasSecretKey()) throw appError('PRECONDITION_FAILED', 'errors.auth.totpUnavailable');
      await confirmPassword(ctx, ctx.auth, input.currentPassword);
      const secret = generateTotpSecret();
      await ctx.tx((tx) =>
        tx
          .update(appUser)
          .set({ totpSecretEnc: sealSecret(secret), totpConfirmedAt: null, totpLastStep: null })
          .where(eq(appUser.id, ctx.auth.userId)),
      );
      const uri = totpUri(secret, ctx.auth.username, 'HMIS');
      const qrSvg = await QRCode.toString(uri, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
      });
      return { secret, uri, qrSvg };
    }),

  /** Step 2: the first code from the phone app switches TOTP on. */
  confirmTotpEnrolment: protectedProcedure
    .meta({ permission: 'session' })
    .input(z.object({ code: totpCodeSchema }))
    .mutation(async ({ ctx, input }) => {
      const [user] = await ctx.db().select().from(appUser).where(eq(appUser.id, ctx.auth.userId));
      if (!user?.totpSecretEnc || user.totpConfirmedAt) {
        throw appError('BAD_REQUEST', 'errors.auth.totpNotStarted');
      }
      const now = ctx.now();
      const step = verifyTotp(openSecret(user.totpSecretEnc), input.code, now, null);
      if (step === null) throw appError('BAD_REQUEST', 'errors.auth.totpInvalid');
      await ctx.tx((tx) =>
        tx
          .update(appUser)
          .set({ totpConfirmedAt: now, totpLastStep: step })
          .where(eq(appUser.id, ctx.auth.userId)),
      );
      return { ok: true as const };
    }),
});

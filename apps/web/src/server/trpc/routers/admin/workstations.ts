import { session, workstation } from '@hmis/db/schema';
import { uuidSchema } from '@hmis/shared';
import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import {
  clearWorkstationCookie,
  workstationCookie,
  workstationFromHeaders,
} from '../../../auth/session';
import { randomToken, sha256Hex } from '../../../auth/tokens';
import { appError, protectedProcedure, setCookie } from '../../init';

const settings = protectedProcedure.meta({ permission: 'admin.settings.manage' });

const nameSchema = z.string().trim().min(2, 'validation.required').max(60);
const locationSchema = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((v) => v || null);

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === '23505';
};

/**
 * Workstations (docs/01 §4–5): named PCs/tablets ("Reception 1") for default printers and for
 * the audit trail. Pairing is an admin action on the device itself and sets an HttpOnly cookie.
 */
export const workstationProcedures = {
  listWorkstations: settings.query(async ({ ctx }) => {
    const current = await workstationFromHeaders(ctx.db(), ctx.headers, ctx.auth.facilityId);
    const rows = await ctx
      .db()
      .select({
        id: workstation.id,
        name: workstation.name,
        location: workstation.location,
        isActive: workstation.isActive,
        pairedAt: workstation.pairedAt,
      })
      .from(workstation)
      .where(eq(workstation.facilityId, ctx.auth.facilityId))
      .orderBy(asc(workstation.name));
    return rows.map((r) => ({ ...r, isThisDevice: r.id === current?.id }));
  }),

  createWorkstation: settings
    .input(z.object({ name: nameSchema, location: locationSchema }))
    .mutation(async ({ ctx, input }) => {
      const id = uuidv7();
      try {
        await ctx.tx((tx) =>
          tx.insert(workstation).values({
            id,
            facilityId: ctx.auth.facilityId,
            name: input.name,
            location: input.location,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw appError('CONFLICT', 'errors.admin.workstationNameTaken');
        throw err;
      }
      return { id };
    }),

  updateWorkstation: settings
    .input(
      z.object({
        workstationId: uuidSchema,
        name: nameSchema,
        location: locationSchema,
        isActive: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const updated = await ctx.tx((tx) =>
          tx
            .update(workstation)
            .set({ name: input.name, location: input.location, isActive: input.isActive })
            .where(
              and(
                eq(workstation.id, input.workstationId),
                eq(workstation.facilityId, ctx.auth.facilityId),
              ),
            )
            .returning({ id: workstation.id }),
        );
        if (updated.length === 0) throw appError('NOT_FOUND', 'errors.notFound');
      } catch (err) {
        if (isUniqueViolation(err)) throw appError('CONFLICT', 'errors.admin.workstationNameTaken');
        throw err;
      }
      return { ok: true as const };
    }),

  /**
   * Pairs the browser making this request with the workstation (one browser at a time:
   * pairing again elsewhere unpairs the previous one). The current session takes it over.
   */
  pairWorkstation: settings
    .input(z.object({ workstationId: uuidSchema }))
    .mutation(async ({ ctx, input }) => {
      const secret = randomToken();
      const now = ctx.now();
      const ws = await ctx.tx(async (tx) => {
        const [row] = await tx
          .update(workstation)
          .set({ pairingTokenHash: sha256Hex(secret), pairedAt: now, pairedBy: ctx.auth.userId })
          .where(
            and(
              eq(workstation.id, input.workstationId),
              eq(workstation.facilityId, ctx.auth.facilityId),
              eq(workstation.isActive, true),
            ),
          )
          .returning({ id: workstation.id, name: workstation.name });
        if (!row) throw appError('NOT_FOUND', 'errors.notFound');
        await tx
          .update(session)
          .set({ workstationId: row.id })
          .where(eq(session.id, ctx.auth.sessionId));
        return row;
      });
      setCookie(ctx, workstationCookie(ws.id, secret));
      return ws;
    }),

  /** Forgets the pairing on this browser only. */
  unpairThisDevice: settings.mutation(async ({ ctx }) => {
    await ctx.tx((tx) =>
      tx.update(session).set({ workstationId: null }).where(eq(session.id, ctx.auth.sessionId)),
    );
    setCookie(ctx, clearWorkstationCookie());
    return { ok: true as const };
  }),

  /** Invalidates the pairing cookie wherever it is (lost/replaced PC). */
  unpairWorkstation: settings
    .input(z.object({ workstationId: uuidSchema }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.tx((tx) =>
        tx
          .update(workstation)
          .set({ pairingTokenHash: null, pairedAt: null, pairedBy: null })
          .where(
            and(
              eq(workstation.id, input.workstationId),
              eq(workstation.facilityId, ctx.auth.facilityId),
            ),
          )
          .returning({ id: workstation.id }),
      );
      if (updated.length === 0) throw appError('NOT_FOUND', 'errors.notFound');
      return { ok: true as const };
    }),
};

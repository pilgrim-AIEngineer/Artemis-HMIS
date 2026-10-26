import {
  cancelVisit,
  createVisit,
  IdempotencyConflictError,
  issueToken,
  previewVisit,
  readSetting,
  VisitInputError,
  type Tx,
} from '@hmis/db';
import { consultationRule, doctorProfile, encounter } from '@hmis/db/schema';
import { cancelVisitSchema, createVisitSchema, uuidSchema, visitPreviewSchema } from '@hmis/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

const create = protectedProcedure.meta({ permission: 'visit.create' });
const cancel = protectedProcedure.meta({ permission: 'visit.cancel' });
/** Manual token before payment is a money decision: only someone who may collect money. */
const collect = protectedProcedure.meta({ permission: 'billing.payment.collect' });

const NOT_FOUND = new Set<string>([
  'visit.patientNotFound',
  'visit.doctorNotFound',
  'visit.notFound',
  'queue.tokenNotFound',
]);
const CONFLICT = new Set<string>([
  'visit.alreadyToday',
  'visit.tokenAlreadyIssued',
  'visit.notOpen',
  'visit.notCancellable',
  'queue.invalidTransition',
  'queue.nothingWaiting',
  'queue.notPending',
]);

/** Domain errors from the db layer become i18n message keys (docs/02 §7). */
export async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof VisitInputError) {
      throw appError(
        NOT_FOUND.has(err.key) ? 'NOT_FOUND' : CONFLICT.has(err.key) ? 'CONFLICT' : 'BAD_REQUEST',
        `errors.${err.key}`,
      );
    }
    if (err instanceof IdempotencyConflictError) {
      throw appError('CONFLICT', 'errors.idempotency.conflict');
    }
    throw err;
  }
}

async function sheetAtReception(
  tx: Tx,
  facilityId: string,
  tokenNo: number | null,
): Promise<boolean> {
  return (
    tokenNo !== null && (await readSetting(tx, facilityId, 'opd.sheetPrintAt')) === 'reception'
  );
}

export const visitsRouter = router({
  /** Doctors reception can book: active, with a consultation fee rule (docs/10 §4). */
  doctors: create.query(({ ctx }) =>
    ctx
      .db()
      .selectDistinct({
        id: doctorProfile.id,
        displayName: doctorProfile.displayName,
        displayNameHi: doctorProfile.displayNameHi,
        qualifications: doctorProfile.qualifications,
        departmentId: doctorProfile.departmentId,
      })
      .from(doctorProfile)
      .innerJoin(
        consultationRule,
        and(eq(consultationRule.doctorId, doctorProfile.id), eq(consultationRule.status, 'active')),
      )
      .where(
        and(
          eq(doctorProfile.facilityId, ctx.auth.facilityId),
          eq(doctorProfile.status, 'active'),
          eq(doctorProfile.isActive, true),
        ),
      )
      .orderBy(asc(doctorProfile.displayName), asc(doctorProfile.id)),
  ),

  /** Suggested visit type, follow-up status and fee for a patient and doctor. Read-only. */
  preview: create
    .input(visitPreviewSchema)
    .query(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => previewVisit(tx, ctx.auth.facilityId, input, ctx.now()))),
    ),

  /** `printSheet`: the token is out and `opd.sheetPrintAt` = `reception`, so print the OPD sheet. */
  create: create.input(createVisitSchema).mutation(({ ctx, input }) =>
    mapped(() =>
      ctx.tx(async (tx) => {
        const v = await createVisit(
          tx,
          { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
          input,
          ctx.now(),
        );
        return { ...v, printSheet: await sheetAtReception(tx, ctx.auth.facilityId, v.tokenNo) };
      }),
    ),
  ),

  /**
   * Gives the token of a visit whose fee is not collected through the system yet (until BIL-01
   * issues it on payment). Recorded as `manual_fee_pending` on the token.
   */
  issueToken: collect.input(z.object({ encounterId: uuidSchema })).mutation(({ ctx, input }) =>
    mapped(() =>
      ctx.tx(async (tx) => {
        const t = await issueToken(
          tx,
          { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
          input.encounterId,
          'manual_fee_pending',
          ctx.now(),
        );
        return { ...t, printSheet: await sheetAtReception(tx, ctx.auth.facilityId, t.tokenNo) };
      }),
    ),
  ),

  cancel: cancel
    .input(cancelVisitSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          cancelVisit(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input.encounterId,
            input.reason,
            ctx.now(),
          ),
        ),
      ),
    ),

  /** Latest visits of a patient, newest first (patient page). */
  forPatient: protectedProcedure
    .meta({ permission: 'patient.view' })
    .input(z.object({ patientId: uuidSchema }))
    .query(({ ctx, input }) =>
      ctx
        .db()
        .select({
          id: encounter.id,
          number: encounter.number,
          visitDate: encounter.visitDate,
          visitType: encounter.visitType,
          status: encounter.status,
          doctorName: doctorProfile.displayName,
          doctorNameHi: doctorProfile.displayNameHi,
        })
        .from(encounter)
        .innerJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
        .where(
          and(
            eq(encounter.facilityId, ctx.auth.facilityId),
            eq(encounter.patientId, input.patientId),
          ),
        )
        .orderBy(desc(encounter.startedAt))
        .limit(10),
    ),
});

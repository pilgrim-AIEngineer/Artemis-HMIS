import {
  cancelDose,
  cancelGrowth,
  cancelPaedsRule,
  checkDose,
  dueSoon,
  getGrowthOverview,
  getImmunisationCard,
  IdempotencyConflictError,
  listPaedsRules,
  paedsRules,
  PaedsInputError,
  recentBatches,
  recordDose,
  recordGrowth,
  setImmunisationSchedule,
  setWhatsappConsent,
  upsertPaedsRule,
  type PaedsActor,
} from '@hmis/db';
import {
  cancelRecordSchema,
  istDateString,
  isoDateSchema,
  noForbiddenTerms,
  paedsRuleInputSchema,
  patientOnlySchema,
  recordDoseSchema,
  recordGrowthSchema,
  setConsentSchema,
  setScheduleSchema,
} from '@hmis/shared';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

/**
 * Paediatrics (OPD-06, docs/11 §4). Reading needs `patient.view`; every change to a child's
 * vaccines and growth needs `clinical.paeds.edit` (AGENTS.md rule 6); the weight-based dose rules
 * are masters (`admin.masters.manage`). Nothing here describes a fetus (AGENTS.md rule 7).
 */
const read = protectedProcedure.meta({ permission: 'patient.view' });
const edit = protectedProcedure.meta({ permission: 'clinical.paeds.edit' });
const masters = protectedProcedure.meta({ permission: 'admin.masters.manage' });

const NOT_FOUND = new Set<string>([
  'paeds.patientNotFound',
  'paeds.doseNotFound',
  'paeds.growthNotFound',
  'paeds.ruleNotFound',
]);
const CONFLICT = new Set<string>(['paeds.doseAlreadyGiven', 'paeds.timingWarning']);

/** Domain errors from the db layer become i18n message keys (docs/02 §7). */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PaedsInputError) {
      const code = NOT_FOUND.has(err.key)
        ? 'NOT_FOUND'
        : CONFLICT.has(err.key)
          ? 'CONFLICT'
          : 'BAD_REQUEST';
      throw appError(code, `errors.${err.key}`);
    }
    if (err instanceof IdempotencyConflictError) {
      throw appError('CONFLICT', 'errors.idempotency.conflict');
    }
    throw err;
  }
}

const actorOf = (ctx: { auth: { facilityId: string; userId: string } }): PaedsActor => ({
  facilityId: ctx.auth.facilityId,
  userId: ctx.auth.userId,
});

export const paedsRouter = router({
  /** The rules in force and whether the paediatrician has signed them off. */
  rules: read.query(({ ctx }) => ctx.tx((tx) => paedsRules(tx, ctx.auth.facilityId))),

  /** Children whose last dose left a next due date close to today (the desk list). */
  dueSoon: read.query(({ ctx }) => ctx.tx((tx) => dueSoon(tx, ctx.auth.facilityId, ctx.now()))),

  /** One child's immunisation card: every dose with its status, doses given, consent, reminders. */
  card: read
    .input(patientOnlySchema)
    .query(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) => getImmunisationCard(tx, actorOf(ctx), input.patientId, ctx.now())),
      ),
    ),

  /** What recording a dose now would raise (too early, after the maximum age, …); saves nothing. */
  checkDose: read
    .input(
      z.object({
        patientId: patientOnlySchema.shape.patientId,
        itemCode: z
          .string()
          .regex(/^[A-Z0-9]+-\d{1,2}$/)
          .nullable(),
        givenOn: isoDateSchema,
      }),
    )
    .query(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => checkDose(tx, actorOf(ctx), input, ctx.now()))),
    ),

  /** Batches recorded before for a vaccine: a quick pick until pharmacy stock is built (Phase 2A). */
  recentBatches: read
    .input(z.object({ vaccineName: z.string().trim().min(1).max(80) }))
    .query(({ ctx, input }) =>
      ctx.tx((tx) =>
        recentBatches(tx, ctx.auth.facilityId, input.vaccineName, istDateString(ctx.now())),
      ),
    ),

  recordDose: edit
    .input(recordDoseSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => recordDose(tx, actorOf(ctx), input, ctx.now()))),
    ),

  cancelDose: edit
    .input(cancelRecordSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => cancelDose(tx, actorOf(ctx), input, ctx.now()))),
    ),

  /** IAP or UIP for one child. */
  setSchedule: edit
    .input(setScheduleSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => setImmunisationSchedule(tx, actorOf(ctx), input, ctx.now()))),
    ),

  /** The family's WhatsApp decision, noted by staff (verbal); updates the queued reminder. */
  setConsent: edit
    .input(setConsentSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => setWhatsappConsent(tx, actorOf(ctx), input, ctx.now()))),
    ),

  growth: read
    .input(patientOnlySchema)
    .query(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => getGrowthOverview(tx, actorOf(ctx), input.patientId, ctx.now()))),
    ),

  recordGrowth: edit
    .input(recordGrowthSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => recordGrowth(tx, actorOf(ctx), input, ctx.now()))),
    ),

  cancelGrowth: edit
    .input(cancelRecordSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => cancelGrowth(tx, actorOf(ctx), input, ctx.now()))),
    ),

  /** The weight-based dose rules (docs/11 §4.4). */
  doseRules: edit.query(({ ctx }) => ctx.tx((tx) => listPaedsRules(tx, ctx.auth.facilityId))),

  saveDoseRule: masters
    .input(
      paedsRuleInputSchema.and(
        z.object({
          approvedBy: z
            .string()
            .trim()
            .min(2)
            .max(120)
            .refine(...noForbiddenTerms('always')),
          approvedOn: isoDateSchema,
        }),
      ),
    )
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => upsertPaedsRule(tx, actorOf(ctx), input, ctx.now()))),
    ),

  cancelDoseRule: masters
    .input(cancelRecordSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => cancelPaedsRule(tx, actorOf(ctx), input, ctx.now()))),
    ),
});

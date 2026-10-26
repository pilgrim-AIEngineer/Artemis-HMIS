import {
  activePregnancies,
  ancRules,
  AncInputError,
  assessScan,
  cancelAncVisit,
  closePregnancy,
  confirmDating,
  createPregnancy,
  getPregnancyView,
  IdempotencyConflictError,
  markScheduleItem,
  patientAnc,
  saveAncVisit,
  saveHistory,
  setGpal,
  updatePregnancy,
  type AncActor,
} from '@hmis/db';
import {
  closePregnancySchema,
  confirmDatingSchema,
  createPregnancySchema,
  markScheduleSchema,
  noForbiddenTerms,
  patientPregnanciesSchema,
  pregnancyIdSchema,
  saveAncVisitSchema,
  saveHistorySchema,
  scanDatingSchema,
  setGpalSchema,
  updatePregnancySchema,
  uuidSchema,
} from '@hmis/shared';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

/**
 * ANC card (OPD-05, docs/11 §3). Reading needs `patient.view`; every change needs
 * `clinical.anc.edit` (AGENTS.md rule 6). MTP outcomes are masked in the db layer from the two MTP
 * permissions passed in `ancActor`.
 */
const read = protectedProcedure.meta({ permission: 'patient.view' });
const edit = protectedProcedure.meta({ permission: 'clinical.anc.edit' });

const NOT_FOUND = new Set<string>(['anc.patientNotFound', 'anc.pregnancyNotFound']);
const CONFLICT = new Set<string>(['anc.activeExists', 'anc.notActive']);
const FORBIDDEN = new Set<string>(['anc.mtpForbidden']);

/** Domain errors from the db layer become i18n message keys (docs/02 §7). */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AncInputError) {
      const code = NOT_FOUND.has(err.key)
        ? 'NOT_FOUND'
        : CONFLICT.has(err.key)
          ? 'CONFLICT'
          : FORBIDDEN.has(err.key)
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
      throw appError(code, `errors.${err.key}`);
    }
    if (err instanceof IdempotencyConflictError) {
      throw appError('CONFLICT', 'errors.idempotency.conflict');
    }
    throw err;
  }
}

const ancActor = (ctx: {
  auth: { facilityId: string; userId: string; permissions: ReadonlySet<string> };
}): AncActor => ({
  facilityId: ctx.auth.facilityId,
  userId: ctx.auth.userId,
  mtp: {
    view: ctx.auth.permissions.has('mtp.register.view'),
    edit: ctx.auth.permissions.has('mtp.register.edit'),
  },
});

export const ancRouter = router({
  /** The rules in force and whether the gynaecologist has signed them off. */
  rules: read.query(({ ctx }) => ctx.tx((tx) => ancRules(tx, ctx.auth.facilityId))),

  /** Active pregnancies, soonest EDD first (the ANC desk list). */
  active: read.query(({ ctx }) =>
    ctx.tx((tx) => activePregnancies(tx, ancActor(ctx), ctx.now())),
  ),

  /** One woman's ANC state: the active pregnancy, earlier ones and the history to pre-fill. */
  forPatient: read
    .input(patientPregnanciesSchema)
    .query(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => patientAnc(tx, ancActor(ctx), input.patientId, ctx.now()))),
    ),

  get: read
    .input(pregnancyIdSchema)
    .query(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) => getPregnancyView(tx, ancActor(ctx), input.pregnancyId, ctx.now())),
      ),
    ),

  /** What a dating scan says against the LMP; saves nothing. */
  assessScan: read.input(scanDatingSchema).query(({ ctx, input }) =>
    mapped(() =>
      ctx.tx((tx) =>
        assessScan(tx, ctx.auth.facilityId, {
          pregnancyId: input.pregnancyId,
          scanDate: input.scanDate,
          ga: input.ga,
        }),
      ),
    ),
  ),

  create: edit
    .input(createPregnancySchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => createPregnancy(tx, ancActor(ctx), input, ctx.now()))),
    ),

  confirmDating: edit
    .input(confirmDatingSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => confirmDating(tx, ancActor(ctx), input, ctx.now()))),
    ),

  update: edit
    .input(updatePregnancySchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => updatePregnancy(tx, ancActor(ctx), input, ctx.now()))),
    ),

  saveHistory: edit
    .input(saveHistorySchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => saveHistory(tx, ancActor(ctx), input, ctx.now()))),
    ),

  setGpal: edit
    .input(setGpalSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => setGpal(tx, ancActor(ctx), input, ctx.now()))),
    ),

  saveVisit: edit
    .input(saveAncVisitSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => saveAncVisit(tx, ancActor(ctx), input, ctx.now()))),
    ),

  cancelVisit: edit
    .input(
      z.object({
        pregnancyId: uuidSchema,
        visitId: uuidSchema,
        reason: z
          .string()
          .trim()
          .min(3)
          .max(200)
          .refine(...noForbiddenTerms('strict')),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => cancelAncVisit(tx, ancActor(ctx), input, ctx.now()))),
    ),

  markSchedule: edit
    .input(markScheduleSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => markScheduleItem(tx, ancActor(ctx), input, ctx.now()))),
    ),

  close: edit
    .input(closePregnancySchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => closePregnancy(tx, ancActor(ctx), input, ctx.now()))),
    ),
});

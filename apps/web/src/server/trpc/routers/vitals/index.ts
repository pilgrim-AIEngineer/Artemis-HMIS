import { recordVitals, vitalsContext, vitalsDesk } from '@hmis/db';
import { recordVitalsSchema, tokenIdSchema } from '@hmis/shared';
import { protectedProcedure, router } from '../../init';
import { mapped } from '../visits';

/** Vitals desk (OPD-01, docs/11 §1): every procedure needs `vitals.record` (AGENTS.md rule 6). */
const desk = protectedProcedure.meta({ permission: 'vitals.record' });

export const vitalsRouter = router({
  /** Patients waiting for vitals (priority first, then oldest) and those measured today. */
  desk: desk.query(({ ctx }) => ctx.tx((tx) => vitalsDesk(tx, ctx.auth.facilityId, ctx.now()))),

  /** Everything the form needs for one token: patient, groups, current reading, thresholds. */
  context: desk
    .input(tokenIdSchema)
    .query(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) => vitalsContext(tx, ctx.auth.facilityId, input.tokenId, ctx.now())),
      ),
    ),

  /**
   * Saves a reading and moves the token to `vitals_done`. `printSheet` tells the screen to print
   * the OPD sheet now (`opd.sheetPrintAt` = `vitals`, the default, docs/10 §7).
   */
  record: desk
    .input(recordVitalsSchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          recordVitals(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),
});

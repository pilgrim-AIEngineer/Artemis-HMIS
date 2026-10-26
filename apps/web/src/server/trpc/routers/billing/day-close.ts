import {
  closeFacilityDay,
  closeOwnDay,
  dayCloseReport,
  DayCloseInputError,
  facilityCloseView,
  IdempotencyConflictError,
  openCounter,
  pendingUpiReconciliations,
  recentOwnCloses,
  saveUpiReconciliation,
  upiReconciliationView,
} from '@hmis/db';
import {
  closeFacilityDaySchema,
  closeOwnDaySchema,
  dayCloseDateSchema,
  dayCloseListSchema,
  istDateString,
  saveUpiReconciliationSchema,
} from '@hmis/shared';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

/** BIL-06: a cashier closes their own counter; admin / owner close the facility day. */
const own = protectedProcedure.meta({ permission: 'billing.dayclose.own' });
const facility = protectedProcedure.meta({ permission: 'billing.dayclose.facility' });
const collectionReport = protectedProcedure.meta({ permission: 'reports.collection' });

const CONFLICT = new Set<string>([
  'dayClose.expectedChanged',
  'dayClose.alreadyClosed',
  'dayClose.pendingUsers',
  'upi.alreadyReconciled',
]);

/** Domain errors from the db layer become i18n message keys (docs/02 §7). */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DayCloseInputError) {
      const code =
        err.key === 'dayClose.notFound'
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

export const dayCloseRouter = router({
  /** What the cashier's counter holds since their last close, and their latest closes. */
  counter: own.query(async ({ ctx }) => {
    const [open, recent] = await Promise.all([
      openCounter(ctx.db(), ctx.auth.facilityId, ctx.auth.userId, ctx.now()),
      recentOwnCloses(ctx.db(), ctx.auth.facilityId, ctx.auth.userId),
    ]);
    return { open, recent };
  }),

  closeOwn: own
    .input(closeOwnDaySchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          closeOwnDay(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  /** Facility close screen / summary of one business day (default: today). */
  facility: facility
    .input(dayCloseDateSchema.partial())
    .query(({ ctx, input }) =>
      facilityCloseView(ctx.db(), ctx.auth.facilityId, input.date ?? istDateString(ctx.now())),
    ),

  closeFacility: facility
    .input(closeFacilityDaySchema)
    .mutation(({ ctx, input }) =>
      mapped(() =>
        ctx.tx((tx) =>
          closeFacilityDay(
            tx,
            { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
            input,
            ctx.now(),
          ),
        ),
      ),
    ),

  /** Day close summary report (docs/20): each user close with expected, counted and difference. */
  report: collectionReport
    .input(dayCloseListSchema)
    .query(({ ctx, input }) => dayCloseReport(ctx.db(), ctx.auth.facilityId, input)),

  upi: router({
    view: facility
      .input(dayCloseDateSchema)
      .query(({ ctx, input }) => upiReconciliationView(ctx.db(), ctx.auth.facilityId, input.date)),

    save: facility
      .input(saveUpiReconciliationSchema)
      .mutation(({ ctx, input }) =>
        mapped(() =>
          ctx.tx((tx) =>
            saveUpiReconciliation(
              tx,
              { facilityId: ctx.auth.facilityId, userId: ctx.auth.userId },
              input,
              ctx.now(),
            ),
          ),
        ),
      ),

    /** Days before today with UPI receipts and no completed reconciliation (dashboard alert). */
    pending: facility
      .input(z.object({}).optional())
      .query(({ ctx }) =>
        pendingUpiReconciliations(ctx.db(), ctx.auth.facilityId, istDateString(ctx.now())),
      ),
  }),
});

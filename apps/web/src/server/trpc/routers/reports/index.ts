import { ancRegister, collectionReport, opdCensus, ownerDashboard, vaccinesDue } from '@hmis/db';
import { doctorProfile } from '@hmis/db/schema';
import {
  ancRegisterInputSchema,
  opdCensusInputSchema,
  reportRangeSchema,
  vaccinesDueInputSchema,
} from '@hmis/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { protectedProcedure, router } from '../../init';

/** RPT-01 / RPT-02 (docs/20): read-only queries, so no transaction, audit row or idempotency key. */
const collection = protectedProcedure.meta({ permission: 'reports.collection' });
const clinical = protectedProcedure.meta({ permission: 'reports.clinical' });
const dashboard = protectedProcedure.meta({ permission: 'reports.owner_dashboard' });

/** Matches no doctor: a doctor without a profile sees an empty census, not everyone's. */
const NO_DOCTOR = '00000000-0000-0000-0000-000000000000';

export const reportsRouter = router({
  /** Daily collection by day, user, mode, doctor and department, with the receipts list. */
  collection: collection
    .input(reportRangeSchema)
    .query(({ ctx, input }) => collectionReport(ctx.db(), ctx.auth.facilityId, input)),

  /**
   * OPD counts by doctor and visit type. A doctor (clinical reports without the financial
   * ones, docs/03 §3 "own reports.clinical") sees only their own visits; the filter is applied
   * here, not in the UI.
   */
  opdCensus: clinical.input(opdCensusInputSchema).query(async ({ ctx, input }) => {
    let doctorId = input.doctorId;
    if (!ctx.auth.permissions.has('reports.financial')) {
      const [own] = await ctx
        .db()
        .select({ id: doctorProfile.id })
        .from(doctorProfile)
        .where(
          and(
            eq(doctorProfile.facilityId, ctx.auth.facilityId),
            eq(doctorProfile.userId, ctx.auth.userId),
          ),
        );
      doctorId = own?.id ?? NO_DOCTOR;
    }
    return opdCensus(ctx.db(), ctx.auth.facilityId, { ...input, doctorId });
  }),

  ancRegister: clinical
    .input(ancRegisterInputSchema)
    .query(({ ctx, input }) => ancRegister(ctx.db(), ctx.auth.facilityId, ctx.now(), input)),

  vaccinesDue: clinical
    .input(vaccinesDueInputSchema)
    .query(({ ctx, input }) => vaccinesDue(ctx.db(), ctx.auth.facilityId, ctx.now(), input)),

  /** The owner's phone page: today, trend, month against last month, alerts. */
  dashboard: dashboard
    .input(z.object({}).optional())
    .query(({ ctx }) => ownerDashboard(ctx.db(), ctx.auth.facilityId, ctx.now())),
});

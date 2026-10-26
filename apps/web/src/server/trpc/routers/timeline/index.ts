import { getTimeline, TimelineInputError } from '@hmis/db';
import { timelineInputSchema, visibleTimelineTypes } from '@hmis/shared';
import { appError, protectedProcedure, router } from '../../init';

/**
 * Patient timeline (OPD-07, docs/11 §2.8). `patient.view` opens it; each kind of item is then
 * filtered by its own permission (`TIMELINE_TYPE_PERMISSIONS`), on the server (AGENTS.md rule 6).
 * Restricted (MTP) records are left out for everyone, `patient.view.restricted` included
 * (AGENTS.md rule 8).
 */
const read = protectedProcedure.meta({ permission: 'patient.view' });

export const timelineRouter = router({
  /** Which kinds of item the caller sees (for the filter chips). */
  types: read.query(({ ctx }) => visibleTimelineTypes(ctx.auth.permissions)),

  /** One page of a patient's timeline, newest first. */
  list: read.input(timelineInputSchema).query(async ({ ctx, input }) => {
    const types = visibleTimelineTypes(ctx.auth.permissions);
    try {
      return await ctx.tx((tx) =>
        getTimeline(
          tx,
          { facilityId: ctx.auth.facilityId, types },
          {
            patientId: input.patientId,
            cursor: input.cursor ?? null,
            limit: input.limit,
            types: input.types,
          },
        ),
      );
    } catch (err) {
      if (err instanceof TimelineInputError) {
        throw appError(
          err.key === 'timeline.patientNotFound' ? 'NOT_FOUND' : 'BAD_REQUEST',
          `errors.${err.key}`,
        );
      }
      throw err;
    }
  }),
});

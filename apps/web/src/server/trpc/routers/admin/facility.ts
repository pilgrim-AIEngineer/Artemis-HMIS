import { facility } from '@hmis/db/schema';
import { facilityProfileSchema } from '@hmis/shared';
import { eq } from 'drizzle-orm';
import { appError, protectedProcedure } from '../../init';

const settings = protectedProcedure.meta({ permission: 'admin.settings.manage' });

/** Facility profile (docs/04 §1): shown on every print header (docs/05 §6). */
export const facilityProcedures = {
  getFacility: settings.query(async ({ ctx }) => {
    const [row] = await ctx
      .db()
      .select({
        name: facility.name,
        shortName: facility.shortName,
        address: facility.address,
        district: facility.district,
        state: facility.state,
        pincode: facility.pincode,
        phone: facility.phone,
        email: facility.email,
        gstin: facility.gstin,
        clinicalEstablishmentRegNo: facility.clinicalEstablishmentRegNo,
        pcpndtRegNo: facility.pcpndtRegNo,
        mtpApprovalNo: facility.mtpApprovalNo,
        drugLicenceNos: facility.drugLicenceNos,
        hfrId: facility.hfrId,
      })
      .from(facility)
      .where(eq(facility.id, ctx.auth.facilityId));
    if (!row) throw appError('NOT_FOUND', 'errors.notFound');
    return { ...row, facilityId: ctx.auth.facilityId };
  }),

  updateFacility: settings.input(facilityProfileSchema).mutation(async ({ ctx, input }) => {
    const updated = await ctx.tx((tx) =>
      tx
        .update(facility)
        .set(input)
        .where(eq(facility.id, ctx.auth.facilityId))
        .returning({ id: facility.id }),
    );
    if (updated.length === 0) throw appError('NOT_FOUND', 'errors.notFound');
    return { ok: true as const };
  }),
};

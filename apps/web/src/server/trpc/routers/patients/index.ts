import {
  findDuplicates,
  PatientInputError,
  registerPatient,
  searchPatients,
  updatePatient,
} from '@hmis/db';
import { facility, locality, patient } from '@hmis/db/schema';
import {
  createPatientSchema,
  duplicateCheckSchema,
  istToday,
  resolveDob,
  SEARCH_LIMIT,
  searchQueryText,
  updatePatientSchema,
  uuidSchema,
} from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';

const view = protectedProcedure.meta({ permission: 'patient.view' });
const create = protectedProcedure.meta({ permission: 'patient.create' });
const edit = protectedProcedure.meta({ permission: 'patient.update' });

/** Input errors from the db layer become i18n keys (docs/02 §7). */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PatientInputError) {
      throw appError(
        err.key === 'patient.notFound' ? 'NOT_FOUND' : 'BAD_REQUEST',
        `errors.${err.key}`,
      );
    }
    throw err;
  }
}

const patientColumns = {
  id: patient.id,
  uhid: patient.uhid,
  firstName: patient.firstName,
  middleName: patient.middleName,
  lastName: patient.lastName,
  fullName: patient.fullName,
  nameHi: patient.nameHi,
  sex: patient.sex,
  dob: patient.dob,
  dobIsEstimated: patient.dobIsEstimated,
  mobile: patient.mobile,
  noMobileReason: patient.noMobileReason,
  altMobile: patient.altMobile,
  relationToMobileOwner: patient.relationToMobileOwner,
  guardianName: patient.guardianName,
  guardianRelation: patient.guardianRelation,
  addressLine: patient.addressLine,
  localityId: patient.localityId,
  localityName: locality.name,
  district: patient.district,
  state: patient.state,
  pincode: patient.pincode,
  bloodGroup: patient.bloodGroup,
  maritalStatus: patient.maritalStatus,
  occupation: patient.occupation,
  referredBy: patient.referredBy,
  isDeceased: patient.isDeceased,
  identityChangedAt: patient.identityChangedAt,
  createdAt: patient.createdAt,
};

export const patientsRouter = router({
  /** Single search box: mobile / UHID / fuzzy name, max 20 rows (REG-02). */
  search: view
    .input(
      z.object({
        q: z.string().max(100),
        limit: z.number().int().min(1).max(SEARCH_LIMIT).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.tx((tx) => searchPatients(tx, ctx.auth.facilityId, input.q, input.limit)),
    ),

  get: view.input(z.object({ id: uuidSchema })).query(async ({ ctx, input }) => {
    const [row] = await ctx
      .db()
      .select(patientColumns)
      .from(patient)
      .leftJoin(locality, eq(locality.id, patient.localityId))
      .where(and(eq(patient.id, input.id), eq(patient.facilityId, ctx.auth.facilityId)));
    if (!row) throw appError('NOT_FOUND', 'errors.patient.notFound');
    return row;
  }),

  /** Defaults for a new registration: the facility's district and state. */
  defaults: create.query(async ({ ctx }) => {
    const [row] = await ctx
      .db()
      .select({ district: facility.district, state: facility.state })
      .from(facility)
      .where(eq(facility.id, ctx.auth.facilityId));
    return { district: row?.district ?? null, state: row?.state ?? null };
  }),

  /** Type-ahead over the seeded and learned localities (docs/05 §2). */
  localities: view.input(z.object({ q: z.string().max(60) })).query(async ({ ctx, input }) => {
    const q = searchQueryText(input.q);
    if (!q) return [];
    return ctx
      .db()
      .select({
        id: locality.id,
        name: locality.name,
        nameHi: locality.nameHi,
        district: locality.district,
        pincode: locality.pincode,
      })
      .from(locality)
      .where(
        and(
          eq(locality.facilityId, ctx.auth.facilityId),
          eq(locality.status, 'active'),
          sql`${locality.searchText} like ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`,
        ),
      )
      .orderBy(
        sql`${locality.searchText} like ${`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} desc`,
        locality.name,
      )
      .limit(8);
  }),

  /** Live duplicate check while the form is filled (the same rule runs again on save). */
  checkDuplicates: create.input(duplicateCheckSchema).query(async ({ ctx, input }) => {
    const dob = resolveDob(input, istToday(ctx.now()));
    if (!dob) return [];
    return ctx.tx((tx) => findDuplicates(tx, ctx.auth.facilityId, { ...input, dob: dob.dob }));
  }),

  /**
   * Registers a patient. Returns `duplicates` (nothing created) when the duplicate rule fires and
   * no `duplicateOverride` reason came with the request.
   */
  create: create
    .input(createPatientSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => registerPatient(tx, ctx.auth.facilityId, input, ctx.now()))),
    ),

  update: edit
    .input(updatePatientSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => ctx.tx((tx) => updatePatient(tx, ctx.auth.facilityId, input, ctx.now()))),
    ),
});

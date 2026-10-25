import { getRate, MasterRefError, pickTariff, setServiceRate } from '@hmis/db';
import {
  appUser,
  consultationRule,
  department,
  doctorProfile,
  drug,
  labTest,
  payer,
  reasonCode,
  service,
  serviceRate,
  tariff,
  usgProcedure,
} from '@hmis/db/schema';
import {
  consultationRuleInputSchema,
  cancelMasterSchema,
  departmentInputSchema,
  departmentUpdateSchema,
  doctorInputSchema,
  doctorUpdateSchema,
  drugInputSchema,
  drugUpdateSchema,
  istToday,
  labTestInputSchema,
  labTestUpdateSchema,
  LAB_DEPARTMENTS,
  masterListSchema,
  payerInputSchema,
  payerUpdateSchema,
  reasonCodeInputSchema,
  reasonCodeUpdateSchema,
  REASON_KINDS,
  searchQueryText,
  SERVICE_CATEGORIES,
  serviceInputSchema,
  serviceRateInputSchema,
  serviceUpdateSchema,
  tariffInputSchema,
  tariffUpdateSchema,
  toIsoDate,
  usgProcedureInputSchema,
  usgProcedureUpdateSchema,
  DRUG_FORMS,
  USG_CATEGORIES,
  uuidSchema,
} from '@hmis/shared';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { appError, protectedProcedure, router } from '../../init';
import { assertActiveRef, masterCrud, translateDbError } from './crud';

const masters = protectedProcedure.meta({ permission: 'admin.masters.manage' });
const tariffs = protectedProcedure.meta({ permission: 'admin.tariff.manage' });

const emptyFilter = z.object({});

// --- departments ---------------------------------------------------------------------------

const departments = masterCrud({
  table: department,
  permission: 'admin.masters.manage',
  sortColumn: department.name,
  listSchema: emptyFilter,
  createSchema: departmentInputSchema,
  updateSchema: departmentUpdateSchema,
  conflicts: { department_code_key: 'errors.masters.codeTaken' },
  async beforeCancel(tx, auth, row) {
    const [doc] = await tx
      .select({ id: doctorProfile.id })
      .from(doctorProfile)
      .where(and(eq(doctorProfile.departmentId, row.id), eq(doctorProfile.status, 'active')))
      .limit(1);
    const [svc] = await tx
      .select({ id: service.id })
      .from(service)
      .where(and(eq(service.departmentId, row.id), eq(service.status, 'active')))
      .limit(1);
    if (doc || svc) throw appError('CONFLICT', 'errors.masters.inUse');
  },
});

// --- doctors -------------------------------------------------------------------------------

const doctors = masterCrud({
  table: doctorProfile,
  permission: 'admin.masters.manage',
  sortColumn: doctorProfile.displayName,
  listSchema: z.object({ departmentId: uuidSchema.optional() }),
  filter: (i) => (i.departmentId ? eq(doctorProfile.departmentId, i.departmentId) : undefined),
  createSchema: doctorInputSchema,
  updateSchema: doctorUpdateSchema,
  conflicts: { doctor_profile_user_key: 'errors.masters.doctorUserTaken' },
  async beforeWrite(tx, auth, input) {
    const i = input as z.output<typeof doctorInputSchema>;
    await assertActiveRef(tx, department, auth.facilityId, i.departmentId);
    if (i.userId) {
      const [u] = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(and(eq(appUser.id, i.userId), eq(appUser.facilityId, auth.facilityId)));
      if (!u) throw appError('BAD_REQUEST', 'errors.masters.badReference');
    }
  },
});

// --- payers and tariffs --------------------------------------------------------------------

async function otherActiveSelfPayer(
  tx: Parameters<typeof assertActiveRef>[0],
  facilityId: string,
  exceptId: string,
) {
  const [row] = await tx
    .select({ id: payer.id })
    .from(payer)
    .where(
      and(
        eq(payer.facilityId, facilityId),
        eq(payer.type, 'self'),
        eq(payer.status, 'active'),
        eq(payer.isActive, true),
        ne(payer.id, exceptId),
      ),
    )
    .limit(1);
  return !!row;
}

const payers = masterCrud({
  table: payer,
  permission: 'admin.tariff.manage',
  sortColumn: payer.name,
  listSchema: emptyFilter,
  createSchema: payerInputSchema,
  updateSchema: payerUpdateSchema,
  conflicts: {
    payer_code_key: 'errors.masters.codeTaken',
    payer_name_key: 'errors.masters.nameTaken',
  },
  async beforeWrite(tx, auth, input, existing) {
    const i = input as z.output<typeof payerInputSchema>;
    // Phase 1 bills only Cash / Self. PM-JAY, TPA and corporate payers can be defined (structure
    // and tariffs) but not switched on until PAY-01 ships (docs/12 §8).
    if (i.type !== 'self' && i.isActive) throw appError('BAD_REQUEST', 'errors.masters.payerPhase');
    if (existing?.type === 'self' && (i.type !== 'self' || !i.isActive)) {
      if (!(await otherActiveSelfPayer(tx, auth.facilityId, existing.id))) {
        throw appError('CONFLICT', 'errors.masters.selfPayerProtected');
      }
    }
  },
  async beforeCancel(tx, auth, row) {
    if (row.type === 'self' && !(await otherActiveSelfPayer(tx, auth.facilityId, row.id))) {
      throw appError('CONFLICT', 'errors.masters.selfPayerProtected');
    }
    const [t] = await tx
      .select({ id: tariff.id })
      .from(tariff)
      .where(and(eq(tariff.payerId, row.id), eq(tariff.status, 'active')))
      .limit(1);
    if (t) throw appError('CONFLICT', 'errors.masters.inUse');
  },
});

async function otherActiveDefaultTariff(
  tx: Parameters<typeof assertActiveRef>[0],
  facilityId: string,
  exceptId: string,
) {
  const [row] = await tx
    .select({ id: tariff.id })
    .from(tariff)
    .where(
      and(
        eq(tariff.facilityId, facilityId),
        sql`${tariff.payerId} is null`,
        eq(tariff.status, 'active'),
        eq(tariff.isActive, true),
        ne(tariff.id, exceptId),
      ),
    )
    .limit(1);
  return !!row;
}

const tariffCrud = masterCrud({
  table: tariff,
  permission: 'admin.tariff.manage',
  sortColumn: tariff.name,
  listSchema: emptyFilter,
  createSchema: tariffInputSchema,
  updateSchema: tariffUpdateSchema,
  conflicts: { tariff_name_key: 'errors.masters.nameTaken' },
  async beforeWrite(tx, auth, input, existing) {
    const i = input as z.output<typeof tariffInputSchema>;
    await assertActiveRef(tx, payer, auth.facilityId, i.payerId);
    // Billing needs a default tariff for payers without their own (docs/12 §1).
    if (existing && existing.payerId === null && (i.payerId !== null || !i.isActive)) {
      if (!(await otherActiveDefaultTariff(tx, auth.facilityId, existing.id))) {
        throw appError('CONFLICT', 'errors.masters.defaultTariffProtected');
      }
    }
  },
  async beforeCancel(tx, auth, row) {
    if (row.payerId === null && !(await otherActiveDefaultTariff(tx, auth.facilityId, row.id))) {
      throw appError('CONFLICT', 'errors.masters.defaultTariffProtected');
    }
  },
});

// --- services ------------------------------------------------------------------------------

const services = masterCrud({
  table: service,
  permission: 'admin.masters.manage',
  sortColumn: service.name,
  listSchema: z.object({
    category: z.enum(SERVICE_CATEGORIES).optional(),
    departmentId: uuidSchema.optional(),
  }),
  filter: (i) =>
    and(
      i.category ? eq(service.category, i.category) : undefined,
      i.departmentId ? eq(service.departmentId, i.departmentId) : undefined,
    ),
  createSchema: serviceInputSchema,
  updateSchema: serviceUpdateSchema,
  conflicts: { service_code_key: 'errors.masters.codeTaken' },
  async beforeWrite(tx, auth, input) {
    const i = input as z.output<typeof serviceInputSchema>;
    await assertActiveRef(tx, department, auth.facilityId, i.departmentId);
    await assertActiveRef(tx, labTest, auth.facilityId, i.linkedLabTestId);
    await assertActiveRef(tx, usgProcedure, auth.facilityId, i.linkedUsgProcedureId);
  },
  async afterWrite(tx, auth, id, input) {
    // lab_test.service_id mirrors service.linked_lab_test_id (docs/04 §2, §8).
    const linked = (input as z.output<typeof serviceInputSchema>).linkedLabTestId;
    await tx
      .update(labTest)
      .set({ serviceId: null })
      .where(and(eq(labTest.serviceId, id), linked ? ne(labTest.id, linked) : undefined));
    if (linked) {
      await tx
        .update(labTest)
        .set({ serviceId: id })
        .where(and(eq(labTest.id, linked), eq(labTest.facilityId, auth.facilityId)));
    }
  },
  async beforeCancel(tx, auth, row) {
    const [rule] = await tx
      .select({ id: consultationRule.id })
      .from(consultationRule)
      .where(and(eq(consultationRule.serviceId, row.id), eq(consultationRule.status, 'active')))
      .limit(1);
    if (rule) throw appError('CONFLICT', 'errors.masters.inUse');
  },
});

// --- drugs, lab tests, USG procedures, reason codes ----------------------------------------

const drugs = masterCrud({
  table: drug,
  permission: 'admin.masters.manage',
  sortColumn: drug.brandName,
  listSchema: z.object({ form: z.enum(DRUG_FORMS).optional() }),
  filter: (i) => (i.form ? eq(drug.form, i.form) : undefined),
  createSchema: drugInputSchema,
  updateSchema: drugUpdateSchema,
  conflicts: { drug_identity_key: 'errors.masters.drugTaken' },
});

const labTests = masterCrud({
  table: labTest,
  permission: 'admin.masters.manage',
  sortColumn: labTest.name,
  listSchema: z.object({ department: z.enum(LAB_DEPARTMENTS).optional() }),
  filter: (i) => (i.department ? eq(labTest.department, i.department) : undefined),
  createSchema: labTestInputSchema,
  updateSchema: labTestUpdateSchema,
  conflicts: { lab_test_code_key: 'errors.masters.codeTaken' },
});

const usgProcedures = masterCrud({
  table: usgProcedure,
  permission: 'admin.masters.manage',
  sortColumn: usgProcedure.name,
  listSchema: z.object({ category: z.enum(USG_CATEGORIES).optional() }),
  filter: (i) => (i.category ? eq(usgProcedure.category, i.category) : undefined),
  createSchema: usgProcedureInputSchema,
  updateSchema: usgProcedureUpdateSchema,
  conflicts: { usg_procedure_code_key: 'errors.masters.codeTaken' },
});

const reasonCodes = masterCrud({
  table: reasonCode,
  permission: 'admin.masters.manage',
  sortColumn: reasonCode.label,
  listSchema: z.object({ kind: z.enum(REASON_KINDS).optional() }),
  filter: (i) => (i.kind ? eq(reasonCode.kind, i.kind) : undefined),
  createSchema: reasonCodeInputSchema,
  updateSchema: reasonCodeUpdateSchema,
  conflicts: { reason_code_key: 'errors.masters.codeTaken' },
});

// --- rates ---------------------------------------------------------------------------------

const rateListSchema = masterListSchema.pick({ search: true, limit: true, cursor: true }).extend({
  tariffId: uuidSchema,
  category: z.enum(SERVICE_CATEGORIES).optional(),
  onlyMissing: z.boolean().default(false),
});

interface RateRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  name_hi: string | null;
  category: string;
  unit: string;
  rate_id: string | null;
  rate_paise: string | null;
  effective_from: string | null;
  next_change_from: string | null;
}

// --- assembled router ----------------------------------------------------------------------

export const mastersRouter = router({
  listDepartments: departments.list,
  createDepartment: departments.create,
  updateDepartment: departments.update,
  cancelDepartment: departments.cancel,
  restoreDepartment: departments.restore,

  listDoctors: doctors.list,
  createDoctor: doctors.create,
  updateDoctor: doctors.update,
  cancelDoctor: doctors.cancel,
  restoreDoctor: doctors.restore,

  listPayers: payers.list,
  createPayer: payers.create,
  updatePayer: payers.update,
  cancelPayer: payers.cancel,
  restorePayer: payers.restore,

  listTariffs: tariffCrud.list,
  createTariff: tariffCrud.create,
  updateTariff: tariffCrud.update,
  cancelTariff: tariffCrud.cancel,
  restoreTariff: tariffCrud.restore,

  listServices: services.list,
  createService: services.create,
  updateService: services.update,
  cancelService: services.cancel,
  restoreService: services.restore,

  listDrugs: drugs.list,
  createDrug: drugs.create,
  updateDrug: drugs.update,
  cancelDrug: drugs.cancel,
  restoreDrug: drugs.restore,

  listLabTests: labTests.list,
  createLabTest: labTests.create,
  updateLabTest: labTests.update,
  cancelLabTest: labTests.cancel,
  restoreLabTest: labTests.restore,

  listUsgProcedures: usgProcedures.list,
  createUsgProcedure: usgProcedures.create,
  updateUsgProcedure: usgProcedures.update,
  cancelUsgProcedure: usgProcedures.cancel,
  restoreUsgProcedure: usgProcedures.restore,

  listReasonCodes: reasonCodes.list,
  createReasonCode: reasonCodes.create,
  updateReasonCode: reasonCodes.update,
  cancelReasonCode: reasonCodes.cancel,
  restoreReasonCode: reasonCodes.restore,

  /** Active users a doctor profile can be linked to. */
  listUserOptions: masters.query(async ({ ctx }) =>
    ctx
      .db()
      .select({ id: appUser.id, fullName: appUser.fullName, username: appUser.username })
      .from(appUser)
      .where(and(eq(appUser.facilityId, ctx.auth.facilityId), eq(appUser.isActive, true)))
      .orderBy(asc(appUser.fullName)),
  ),

  /** Consultation fee/follow-up rules of one doctor, with the fee in the default tariff. */
  listConsultationRules: masters
    .input(z.object({ doctorId: uuidSchema }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db();
      const today = toIsoDate(istToday(ctx.now()));
      const rows = await db
        .select({
          id: consultationRule.id,
          visitType: consultationRule.visitType,
          serviceId: consultationRule.serviceId,
          serviceCode: service.code,
          serviceName: service.name,
          followUpValidityDays: consultationRule.followUpValidityDays,
          freeFollowUpsCount: consultationRule.freeFollowUpsCount,
        })
        .from(consultationRule)
        .innerJoin(service, eq(service.id, consultationRule.serviceId))
        .where(
          and(
            eq(consultationRule.facilityId, ctx.auth.facilityId),
            eq(consultationRule.doctorId, input.doctorId),
            eq(consultationRule.status, 'active'),
          ),
        )
        .orderBy(asc(consultationRule.visitType));
      const tariffId = await pickTariff(db, {
        facilityId: ctx.auth.facilityId,
        payerId: null,
        on: today,
      });
      return Promise.all(
        rows.map(async (r) => ({
          ...r,
          feePaise: tariffId
            ? ((
                await getRate(db, {
                  facilityId: ctx.auth.facilityId,
                  serviceId: r.serviceId,
                  tariffId,
                  on: today,
                })
              )?.ratePaise ?? null)
            : null,
        })),
      );
    }),

  /** Creates or replaces the active rule for (doctor, visit type). */
  setConsultationRule: masters
    .input(consultationRuleInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.tx(async (tx) => {
          await assertActiveRef(tx, doctorProfile, ctx.auth.facilityId, input.doctorId);
          await assertActiveRef(tx, service, ctx.auth.facilityId, input.serviceId);
          const [svc] = await tx
            .select({ category: service.category })
            .from(service)
            .where(eq(service.id, input.serviceId));
          if (svc?.category !== 'consultation')
            throw appError('BAD_REQUEST', 'errors.masters.notConsultation');
          const values = {
            serviceId: input.serviceId,
            followUpValidityDays: input.followUpValidityDays,
            freeFollowUpsCount: input.freeFollowUpsCount,
          };
          const [existing] = await tx
            .select({ id: consultationRule.id })
            .from(consultationRule)
            .where(
              and(
                eq(consultationRule.facilityId, ctx.auth.facilityId),
                eq(consultationRule.doctorId, input.doctorId),
                eq(consultationRule.visitType, input.visitType),
                eq(consultationRule.status, 'active'),
              ),
            )
            .for('update');
          if (existing) {
            await tx
              .update(consultationRule)
              .set(values)
              .where(eq(consultationRule.id, existing.id));
            return { id: existing.id };
          }
          const id = uuidv7();
          await tx.insert(consultationRule).values({
            id,
            facilityId: ctx.auth.facilityId,
            doctorId: input.doctorId,
            visitType: input.visitType,
            ...values,
          });
          return { id };
        });
      } catch (err) {
        translateDbError(err);
      }
    }),

  cancelConsultationRule: masters.input(cancelMasterSchema).mutation(async ({ ctx, input }) => {
    const updated = await ctx.tx((tx) =>
      tx
        .update(consultationRule)
        .set({
          status: 'cancelled',
          cancelReason: input.reason,
          cancelledAt: sql`now()`,
          cancelledBy: ctx.auth.userId,
        })
        .where(
          and(
            eq(consultationRule.id, input.id),
            eq(consultationRule.facilityId, ctx.auth.facilityId),
            eq(consultationRule.status, 'active'),
          ),
        )
        .returning({ id: consultationRule.id }),
    );
    if (updated.length === 0) throw appError('NOT_FOUND', 'errors.notFound');
    return { ok: true as const };
  }),

  /** Active services with their rate in one tariff on today's date (IST); "—" = no rate yet. */
  listServiceRates: tariffs.input(rateListSchema).query(async ({ ctx, input }) => {
    const db = ctx.db();
    const fid = ctx.auth.facilityId;
    const [t] = await db
      .select({ id: tariff.id })
      .from(tariff)
      .where(and(eq(tariff.id, input.tariffId), eq(tariff.facilityId, fid)));
    if (!t) throw appError('NOT_FOUND', 'errors.notFound');
    const today = toIsoDate(istToday(ctx.now()));
    const q = searchQueryText(input.search ?? '');
    const conds = [
      sql`s.facility_id = ${fid}`,
      sql`s.status = 'active'`,
      input.category ? sql`s.category = ${input.category}` : sql`true`,
      input.onlyMissing ? sql`r.id is null` : sql`true`,
      q ? sql`(s.search_text like ${`%${q}%`} or ${q} <% s.search_text)` : sql`true`,
    ];
    let cursorCond = sql`true`;
    if (!q && input.cursor) {
      try {
        const [sortValue, id] = z
          .tuple([z.string(), z.uuid()])
          .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        cursorCond = sql`(lower(s.name), s.id) > (${sortValue}, ${id}::uuid)`;
      } catch {
        throw appError('BAD_REQUEST', 'errors.masters.invalid');
      }
    }
    const res = await db.execute<RateRow>(sql`
      select s.id, s.code, s.name, s.name_hi, s.category, s.unit,
             r.id as rate_id, r.rate_paise::text as rate_paise, r.effective_from::text as effective_from,
             (select min(f.effective_from)::text from service_rate f
               where f.service_id = s.id and f.tariff_id = ${input.tariffId} and f.status = 'active'
                 and f.room_category_id is null and f.effective_from > ${today}::date) as next_change_from
      from service s
      left join lateral (
        select x.id, x.rate_paise, x.effective_from from service_rate x
        where x.service_id = s.id and x.tariff_id = ${input.tariffId} and x.status = 'active'
          and x.room_category_id is null and x.effective_from <= ${today}::date
        order by x.effective_from desc, x.id desc limit 1) r on true
      where ${sql.join(conds, sql` and `)} and ${cursorCond}
      order by ${q ? sql`word_similarity(${q}, s.search_text) desc,` : sql``} lower(s.name), s.id
      limit ${input.limit + 1}`);
    const page = res.rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({
        serviceId: r.id,
        code: r.code,
        name: r.name,
        nameHi: r.name_hi,
        category: r.category,
        unit: r.unit,
        ratePaise: r.rate_paise === null ? null : BigInt(r.rate_paise),
        effectiveFrom: r.effective_from,
        nextChangeFrom: r.next_change_from,
      })),
      nextCursor:
        !q && res.rows.length > input.limit && last
          ? Buffer.from(JSON.stringify([last.name.toLowerCase(), last.id])).toString('base64url')
          : null,
      today,
    };
  }),

  /** Sets a rate from a date (new row, or a same-day correction; see `setServiceRate`). */
  setServiceRate: tariffs.input(serviceRateInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await ctx.tx((tx) =>
        setServiceRate(tx, {
          facilityId: ctx.auth.facilityId,
          serviceId: input.serviceId,
          tariffId: input.tariffId,
          roomCategoryId: input.roomCategoryId,
          ratePaise: input.ratePaise,
          effectiveFrom: input.effectiveFrom,
        }),
      );
    } catch (err) {
      if (err instanceof MasterRefError) throw appError('NOT_FOUND', 'errors.notFound');
      translateDbError(err);
    }
  }),

  /** Every rate row of one service in one tariff, newest first, including cancelled ones. */
  listRateHistory: tariffs
    .input(z.object({ serviceId: uuidSchema, tariffId: uuidSchema }))
    .query(async ({ ctx, input }) =>
      ctx
        .db()
        .select({
          id: serviceRate.id,
          ratePaise: serviceRate.ratePaise,
          effectiveFrom: serviceRate.effectiveFrom,
          status: serviceRate.status,
          cancelReason: serviceRate.cancelReason,
          createdAt: serviceRate.createdAt,
          createdBy: serviceRate.createdBy,
        })
        .from(serviceRate)
        .where(
          and(
            eq(serviceRate.facilityId, ctx.auth.facilityId),
            eq(serviceRate.serviceId, input.serviceId),
            eq(serviceRate.tariffId, input.tariffId),
          ),
        )
        .orderBy(desc(serviceRate.effectiveFrom), desc(serviceRate.createdAt)),
    ),
});

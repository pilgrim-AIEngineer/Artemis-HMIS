/**
 * Organisation and master tables (docs/04 §2, FND-07). Every table carries `facility_id`, the
 * audit columns and the soft-cancel fields. `search_text` is a generated column feeding a trigram
 * index (`hmis_search_text`, migration 0005) so the pickers search names and short codes fast.
 * Audit/touch triggers are attached in migration 0007.
 */
import {
  DRUG_FORMS,
  DRUG_SCHEDULES,
  LAB_DEPARTMENTS,
  LAB_RESULT_TYPES,
  PAYER_TYPES,
  REASON_KINDS,
  SERVICE_CATEGORIES,
  SERVICE_UNITS,
  USG_CATEGORIES,
  VISIT_TYPES,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  type ExtraConfigColumn,
} from 'drizzle-orm/pg-core';
import { auditColumns, cancelChecks, cancelColumns, idColumn, sqlIn } from './columns';
import { appUser, document, facilityRef } from './platform';

const searchText = (expr: string) =>
  text('search_text').generatedAlwaysAs(sql.raw(`hmis_search_text(${expr})`));

const trgm = (name: string, t: { searchText: ExtraConfigColumn }) =>
  index(name).using('gin', t.searchText.op('gin_trgm_ops'));

export const department = pgTable(
  'department',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    name: text().notNull(),
    nameHi: text(),
    /** GYN, PAED, CARD, PATH, RAD, PHARM, ANES … */
    code: text().notNull(),
    isClinical: boolean().notNull().default(true),
    /** Inactive: hidden from pickers (e.g. CARD until Phase 3), reversible, no reason needed. */
    isActive: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(100),
    searchText: searchText('name, name_hi, code, null'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('department_code_key').on(t.facilityId, sql`lower(${t.code})`),
    ...cancelChecks('department', t),
  ],
);

export const doctorProfile = pgTable(
  'doctor_profile',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    /** NULL for visiting doctors without a login. */
    userId: uuid().references(() => appUser.id),
    departmentId: uuid()
      .notNull()
      .references(() => department.id),
    displayName: text().notNull(),
    displayNameHi: text(),
    qualifications: text(),
    registrationCouncil: text(),
    registrationNo: text(),
    signatureFileId: uuid().references(() => document.id),
    isVisiting: boolean().notNull().default(false),
    /** `["mon","tue",…]`. Fees and follow-up rules live in `consultation_rule`. */
    opdDays: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean().notNull().default(true),
    searchText: searchText('display_name, display_name_hi, qualifications, registration_no'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    index('doctor_profile_department_idx').on(t.departmentId),
    uniqueIndex('doctor_profile_user_key')
      .on(t.facilityId, t.userId)
      .where(sql`${t.userId} is not null and ${t.status} = 'active'`),
    trgm('doctor_profile_search_trgm', t),
    check('doctor_profile_opd_days_array', sql`jsonb_typeof(${t.opdDays}) = 'array'`),
    ...cancelChecks('doctor_profile', t),
  ],
);

export const payer = pgTable(
  'payer',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    name: text().notNull(),
    type: text().notNull(),
    code: text().notNull(),
    contact: text(),
    creditDays: integer().notNull().default(0),
    requiresPreauth: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    searchText: searchText('name, code, contact, null'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('payer_code_key').on(t.facilityId, sql`lower(${t.code})`),
    uniqueIndex('payer_name_key').on(t.facilityId, sql`lower(${t.name})`),
    check('payer_type', sqlIn(t.type, PAYER_TYPES)),
    check('payer_credit_days', sql`${t.creditDays} between 0 and 365`),
    ...cancelChecks('payer', t),
  ],
);

export const tariff = pgTable(
  'tariff',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    name: text().notNull(),
    /** NULL: the default tariff for encounters whose payer has none of its own. */
    payerId: uuid().references(() => payer.id),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    effectiveTo: date({ mode: 'string' }),
    isActive: boolean().notNull().default(true),
    searchText: searchText('name, null, null, null'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('tariff_name_key').on(t.facilityId, sql`lower(${t.name})`),
    index('tariff_payer_idx').on(t.payerId),
    check('tariff_dates', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    ...cancelChecks('tariff', t),
  ],
);

export const usgProcedure = pgTable(
  'usg_procedure',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    code: text().notNull(),
    name: text().notNull(),
    category: text().notNull(),
    /** Form F gating when the woman is pregnant (docs/33 §3, docs/13). */
    requiresFormFIfPregnant: boolean().notNull().default(true),
    /** Set by USG-01 once `usg_template` exists. */
    defaultTemplateId: uuid(),
    isActive: boolean().notNull().default(true),
    searchText: searchText('name, code, null, null'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('usg_procedure_code_key').on(t.facilityId, sql`lower(${t.code})`),
    check('usg_procedure_category', sqlIn(t.category, USG_CATEGORIES)),
    ...cancelChecks('usg_procedure', t),
  ],
);

export const labTest = pgTable(
  'lab_test',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    code: text().notNull(),
    name: text().notNull(),
    shortCode: text(),
    department: text().notNull(),
    sampleType: text(),
    container: text(),
    method: text(),
    unit: text(),
    resultType: text().notNull().default('numeric'),
    formula: text(),
    options: jsonb(),
    decimals: integer(),
    tatHours: integer(),
    isOutsourced: boolean().notNull().default(false),
    outsourceLab: text(),
    /** The billing service for this test (kept in step with `service.linked_lab_test_id`). */
    serviceId: uuid().references((): AnyPgColumn => service.id),
    isActive: boolean().notNull().default(true),
    searchText: searchText('name, code, short_code, null'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('lab_test_code_key').on(t.facilityId, sql`lower(${t.code})`),
    trgm('lab_test_search_trgm', t),
    check('lab_test_department', sqlIn(t.department, LAB_DEPARTMENTS)),
    check('lab_test_result_type', sqlIn(t.resultType, LAB_RESULT_TYPES)),
    ...cancelChecks('lab_test', t),
  ],
);

export const service = pgTable(
  'service',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    code: text().notNull(),
    name: text().notNull(),
    nameHi: text(),
    shortCode: text(),
    category: text().notNull(),
    departmentId: uuid().references(() => department.id),
    sacCode: text(),
    /** GST in basis points: 500 = 5% (AGENTS.md rule 1). */
    defaultGstRateBp: integer().notNull().default(0),
    isExempt: boolean().notNull().default(true),
    unit: text().notNull().default('per_visit'),
    linkedLabTestId: uuid().references((): AnyPgColumn => labTest.id),
    linkedUsgProcedureId: uuid().references(() => usgProcedure.id),
    isActive: boolean().notNull().default(true),
    searchText: searchText('name, name_hi, code, short_code'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('service_code_key').on(t.facilityId, sql`lower(${t.code})`),
    index('service_category_idx').on(t.facilityId, t.category),
    trgm('service_search_trgm', t),
    check('service_category', sqlIn(t.category, SERVICE_CATEGORIES)),
    check('service_unit', sqlIn(t.unit, SERVICE_UNITS)),
    check('service_gst_bp', sql`${t.defaultGstRateBp} between 0 and 10000`),
    check('service_exempt_no_gst', sql`not ${t.isExempt} or ${t.defaultGstRateBp} = 0`),
    ...cancelChecks('service', t),
  ],
);

/**
 * A price of a service in a tariff from `effective_from` (docs/12 §1). Rates are append-only in
 * effect: a change inserts a new row; a same-day correction cancels the old row with a reason.
 * `room_category_id` joins `room_category` when IPD lands (P2A); until then it stays NULL.
 */
export const serviceRate = pgTable(
  'service_rate',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    serviceId: uuid()
      .notNull()
      .references(() => service.id),
    tariffId: uuid()
      .notNull()
      .references(() => tariff.id),
    roomCategoryId: uuid(),
    ratePaise: bigint({ mode: 'bigint' }).notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('service_rate_active_key')
      .on(
        t.facilityId,
        t.serviceId,
        t.tariffId,
        sql`coalesce(${t.roomCategoryId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.effectiveFrom,
      )
      .where(sql`${t.status} = 'active'`),
    index('service_rate_lookup_idx').on(t.tariffId, t.serviceId, t.effectiveFrom),
    check('service_rate_nonnegative', sql`${t.ratePaise} >= 0`),
    ...cancelChecks('service_rate', t),
  ],
);

export const consultationRule = pgTable(
  'consultation_rule',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    doctorId: uuid()
      .notNull()
      .references(() => doctorProfile.id),
    visitType: text().notNull(),
    serviceId: uuid()
      .notNull()
      .references(() => service.id),
    /** NULL: setting `opd.followUpValidityDays` (docs/40 Q6). */
    followUpValidityDays: integer(),
    /** NULL: setting `opd.freeFollowUps` (docs/40 Q6). */
    freeFollowUpsCount: integer(),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('consultation_rule_active_key')
      .on(t.facilityId, t.doctorId, t.visitType)
      .where(sql`${t.status} = 'active'`),
    check('consultation_rule_visit_type', sqlIn(t.visitType, VISIT_TYPES)),
    check(
      'consultation_rule_ranges',
      sql`(${t.followUpValidityDays} is null or ${t.followUpValidityDays} between 0 and 365)
        and (${t.freeFollowUpsCount} is null or ${t.freeFollowUpsCount} between 0 and 20)`,
    ),
    ...cancelChecks('consultation_rule', t),
  ],
);

export const drug = pgTable(
  'drug',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    brandName: text().notNull(),
    genericName: text(),
    shortCode: text(),
    strength: text(),
    form: text().notNull().default('tab'),
    manufacturer: text(),
    hsnCode: text(),
    gstRateBp: integer().notNull().default(0),
    schedule: text().notNull().default('none'),
    isStocked: boolean().notNull().default(true),
    defaultDoseText: text(),
    packSize: text(),
    isActive: boolean().notNull().default(true),
    searchText: searchText('brand_name, generic_name, short_code, manufacturer'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('drug_identity_key').on(
      t.facilityId,
      sql`lower(${t.brandName})`,
      sql`lower(coalesce(${t.strength}, ''))`,
      t.form,
      sql`lower(coalesce(${t.manufacturer}, ''))`,
    ),
    trgm('drug_search_trgm', t),
    check('drug_form', sqlIn(t.form, DRUG_FORMS)),
    check('drug_schedule', sqlIn(t.schedule, DRUG_SCHEDULES)),
    check('drug_gst_bp', sql`${t.gstRateBp} between 0 and 10000`),
    ...cancelChecks('drug', t),
  ],
);

export const locality = pgTable(
  'locality',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    name: text().notNull(),
    nameHi: text(),
    district: text(),
    pincode: text(),
    /** Added by staff at registration (type-ahead "learned"), not from the seeded list. */
    learned: boolean().notNull().default(false),
    searchText: searchText('name, name_hi, pincode, district'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    trgm('locality_search_trgm', t),
    check('locality_pincode', sql`${t.pincode} is null or ${t.pincode} ~ '^[1-9][0-9]{5}$'`),
    ...cancelChecks('locality', t),
  ],
);

export const reasonCode = pgTable(
  'reason_code',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    kind: text().notNull(),
    code: text().notNull(),
    label: text().notNull(),
    labelHi: text(),
    isActive: boolean().notNull().default(true),
    searchText: searchText('label, label_hi, code, kind'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('reason_code_key').on(t.facilityId, t.kind, t.code),
    check('reason_code_kind', sqlIn(t.kind, REASON_KINDS)),
    ...cancelChecks('reason_code', t),
  ],
);

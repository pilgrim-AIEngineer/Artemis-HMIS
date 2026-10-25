/**
 * Patient master (docs/04 §3, REG-01). `search_name_norm` / `search_name_phonetic` are derived in
 * the app with `nameSearchKeys` (@hmis/shared) and feed the GIN trigram indexes (REG-02);
 * `full_name` is generated. A patient is never deleted: `status = 'cancelled'` hides a row
 * registered by mistake, `merged_into_id` points at the survivor of a merge (AGENTS.md rule 4).
 * Fetal sex has no column anywhere (rule 7); `sex` is the patient's own.
 */
import {
  BLOOD_GROUPS,
  GUARDIAN_RELATIONS,
  MARITAL_STATUSES,
  MOBILE_OWNER_RELATIONS,
  PATIENT_SEXES,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { auditColumns, cancelChecks, cancelColumns, idColumn, sqlIn } from './columns';
import { locality } from './masters';
import { document, facilityRef } from './platform';

export const patient = pgTable(
  'patient',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    /** `UH-000123`, from the never-resetting `uhid` number series in the registering transaction. */
    uhid: text().notNull(),
    firstName: text().notNull(),
    middleName: text(),
    lastName: text(),
    fullName: text('full_name').generatedAlwaysAs(
      sql`btrim(regexp_replace(coalesce(first_name, '') || ' ' || coalesce(middle_name, '') || ' ' || coalesce(last_name, ''), '\\s+', ' ', 'g'))`,
    ),
    nameHi: text(),
    sex: text().notNull(),
    dob: date({ mode: 'string' }).notNull(),
    dobIsEstimated: boolean().notNull().default(false),
    mobile: text(),
    /** Reason when the patient has no mobile (docs/10 §3 "No mobile" checkbox). */
    noMobileReason: text(),
    altMobile: text(),
    relationToMobileOwner: text(),
    guardianName: text(),
    guardianRelation: text(),
    addressLine: text(),
    localityId: uuid().references(() => locality.id),
    district: text(),
    state: text(),
    pincode: text(),
    bloodGroup: text(),
    maritalStatus: text(),
    occupation: text(),
    referredBy: text(),
    photoFileId: uuid().references(() => document.id),
    isDeceased: boolean().notNull().default(false),
    deceasedAt: timestamp({ withTimezone: true }),
    mergedIntoId: uuid().references((): AnyPgColumn => patient.id),
    /** Set when name, DOB or sex was edited after registration: the "changed" badge (docs/10 §3). */
    identityChangedAt: timestamp({ withTimezone: true }),
    /** Reason given for "Create new anyway" in the duplicate prompt (logged, docs/10 §3). */
    duplicateOverrideReason: text(),
    searchNameNorm: text().notNull().default(''),
    searchNamePhonetic: text().notNull().default(''),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('patient_uhid_key').on(t.facilityId, t.uhid),
    index('patient_mobile_idx').on(t.facilityId, t.mobile),
    index('patient_alt_mobile_idx').on(t.facilityId, t.altMobile),
    index('patient_name_norm_trgm').using('gin', t.searchNameNorm.op('gin_trgm_ops')),
    index('patient_name_phonetic_trgm').using('gin', t.searchNamePhonetic.op('gin_trgm_ops')),
    index('patient_name_hi_trgm').using('gin', t.nameHi.op('gin_trgm_ops')),
    index('patient_locality_idx').on(t.localityId),
    check('patient_sex', sqlIn(t.sex, PATIENT_SEXES)),
    check(
      'patient_guardian_relation',
      sql`${t.guardianRelation} is null or ${sqlIn(t.guardianRelation, GUARDIAN_RELATIONS)}`,
    ),
    check(
      'patient_mobile_owner_relation',
      sql`${t.relationToMobileOwner} is null or ${sqlIn(t.relationToMobileOwner, MOBILE_OWNER_RELATIONS)}`,
    ),
    check(
      'patient_marital_status',
      sql`${t.maritalStatus} is null or ${sqlIn(t.maritalStatus, MARITAL_STATUSES)}`,
    ),
    check(
      'patient_blood_group',
      sql`${t.bloodGroup} is null or ${t.bloodGroup} in (${sql.raw(BLOOD_GROUPS.map((g) => `'${g}'`).join(', '))})`,
    ),
    check('patient_mobile_format', sql`${t.mobile} is null or ${t.mobile} ~ '^[6-9][0-9]{9}$'`),
    check(
      'patient_alt_mobile_format',
      sql`${t.altMobile} is null or ${t.altMobile} ~ '^[6-9][0-9]{9}$'`,
    ),
    check('patient_pincode_format', sql`${t.pincode} is null or ${t.pincode} ~ '^[1-9][0-9]{5}$'`),
    check(
      'patient_mobile_or_reason',
      sql`${t.mobile} is not null or ${t.noMobileReason} is not null`,
    ),
    check('patient_deceased_fields', sql`${t.isDeceased} or ${t.deceasedAt} is null`),
    ...cancelChecks('patient', t),
  ],
);

/**
 * Paediatrics (OPD-06, docs/04 §5, docs/11 §4): the immunisation schedule master, each child's
 * schedule choice, vaccine doses given (with batch), growth measurements with their WHO z-scores,
 * the paediatrician's weight-based dose rules, and the two small tables the vaccine reminder
 * needs: the WhatsApp consent and the outbox (docs/04 §13; the sender is MSG-01). Rows are
 * cancelled, never deleted (AGENTS.md rule 4). Nothing here describes a fetus (AGENTS.md rule 7).
 */
import {
  CONSENT_KINDS,
  CONSENT_METHODS,
  IMMUNISATION_SCHEDULES,
  MESSAGE_OUTBOX_STATUSES,
  VACCINE_ROUTES,
  VACCINE_SITES,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, cancelChecks, cancelColumns, idColumn, sqlIn } from './columns';
import { patient } from './patient';
import { appUser, document, facilityRef } from './platform';
import { encounter } from './visit';

/** Schedule master (docs/33 §5, seeded; the paediatrician edits it). */
export const immunisationSchedule = pgTable(
  'immunisation_schedule',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    scheduleName: text().notNull(),
    vaccineCode: text().notNull(),
    doseNo: smallint().notNull(),
    label: text().notNull(),
    labelHi: text().notNull(),
    dueAgeDays: integer().notNull(),
    minAgeDays: integer().notNull(),
    maxAgeDays: integer(),
    /** Minimum days after the previous dose of the same vaccine; null for the first dose. */
    minIntervalDays: integer(),
    isOptional: boolean().notNull().default(false),
    /** `F` / `M` when the dose is for one sex only (HPV in the draft). */
    onlySex: text(),
    sortOrder: smallint().notNull().default(0),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('immunisation_schedule_key').on(
      t.facilityId,
      t.scheduleName,
      t.vaccineCode,
      t.doseNo,
    ),
    check('immunisation_schedule_name', sqlIn(t.scheduleName, IMMUNISATION_SCHEDULES)),
    check('immunisation_schedule_dose_no', sql`${t.doseNo} >= 1`),
    check(
      'immunisation_schedule_ages',
      sql`${t.minAgeDays} >= 0 and ${t.dueAgeDays} >= ${t.minAgeDays} and (${t.maxAgeDays} is null or ${t.maxAgeDays} >= ${t.dueAgeDays})`,
    ),
    check(
      'immunisation_schedule_interval',
      sql`${t.minIntervalDays} is null or ${t.minIntervalDays} >= 0`,
    ),
    check('immunisation_schedule_sex', sql`${t.onlySex} is null or ${t.onlySex} in ('F', 'M')`),
  ],
);

/** Which schedule a child follows. No row = the facility default (`immunisation.defaultSchedule`). */
export const immunisationProfile = pgTable(
  'immunisation_profile',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    scheduleName: text().notNull(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('immunisation_profile_patient_key').on(t.patientId),
    check('immunisation_profile_name', sqlIn(t.scheduleName, IMMUNISATION_SCHEDULES)),
  ],
);

/** A vaccine dose that was given, with its batch (docs/11 §4.1). */
export const immunisationGiven = pgTable(
  'immunisation_given',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** `DTP-2`; null for a vaccine outside the schedule. */
    itemCode: text(),
    scheduleItemId: uuid().references(() => immunisationSchedule.id),
    /** The schedule the dose was counted under when it was given. */
    scheduleName: text().notNull(),
    vaccineName: text().notNull(),
    brand: text(),
    batchNo: text().notNull(),
    expiry: date({ mode: 'string' }).notNull(),
    site: text().notNull(),
    route: text().notNull(),
    givenOn: date({ mode: 'string' }).notNull(),
    givenBy: uuid()
      .notNull()
      .references(() => appUser.id),
    encounterId: uuid().references(() => encounter.id),
    /** The child's next compulsory due date, worked out when this dose was saved. */
    nextDueDate: date({ mode: 'string' }),
    /** Timing warnings (too early, after max age, …) the person confirmed. */
    warnings: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('immunisation_given_dose_key')
      .on(t.patientId, t.itemCode)
      .where(sql`${t.status} = 'active' and ${t.itemCode} is not null`),
    index('immunisation_given_patient_idx').on(t.patientId, t.givenOn.desc()),
    index('immunisation_given_batch_idx').on(t.facilityId, t.batchNo),
    check('immunisation_given_schedule', sqlIn(t.scheduleName, IMMUNISATION_SCHEDULES)),
    check('immunisation_given_site', sqlIn(t.site, VACCINE_SITES)),
    check('immunisation_given_route', sqlIn(t.route, VACCINE_ROUTES)),
    check('immunisation_given_batch', sql`btrim(${t.batchNo}) <> ''`),
    check('immunisation_given_expiry', sql`${t.expiry} >= ${t.givenOn}`),
    ...cancelChecks('immunisation_given', t),
  ],
);

/** Weight, length / height and head circumference with the z-scores computed when saved. */
export const growthMeasurement = pgTable(
  'growth_measurement',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    encounterId: uuid().references(() => encounter.id),
    measuredOn: date({ mode: 'string' }).notNull(),
    ageDays: integer().notNull(),
    weightKg: numeric({ precision: 6, scale: 2 }),
    lengthHeightCm: numeric({ precision: 5, scale: 1 }),
    headCircCm: numeric({ precision: 4, scale: 1 }),
    /** `StoredZScores` (@hmis/shared): wfa, lhfa, hcfa, wfh, implausible, skipped. */
    zScores: jsonb().notNull(),
    /** `vitals` when the vitals desk filled it, else `paeds`. */
    source: text().notNull().default('paeds'),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('growth_measurement_day_key')
      .on(t.patientId, t.measuredOn)
      .where(sql`${t.status} = 'active'`),
    index('growth_measurement_patient_idx').on(t.patientId, t.measuredOn.desc()),
    check('growth_measurement_source', sqlIn(t.source, ['vitals', 'paeds'])),
    check(
      'growth_measurement_any',
      sql`${t.weightKg} is not null or ${t.lengthHeightCm} is not null or ${t.headCircCm} is not null`,
    ),
    ...cancelChecks('growth_measurement', t),
  ],
);

/**
 * Weight-based dose rule (docs/11 §4.4). Rows come ONLY from a list the hospital's paediatrician
 * approved: there is no seed. `generic_name` is stored lower-case and matched with the drug's.
 */
export const drugPaedsRule = pgTable(
  'drug_paeds_rule',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    genericName: text().notNull(),
    mgPerKgMin: numeric({ precision: 8, scale: 3 }).notNull(),
    mgPerKgMax: numeric({ precision: 8, scale: 3 }).notNull(),
    maxMgPerDose: numeric({ precision: 10, scale: 2 }),
    maxDosesPerDay: smallint(),
    /** mg per ml by drug form (`{"syp": 25}`). */
    concentrationMgPerMl: jsonb()
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    note: text(),
    /** Who approved the rule and when (free text, e.g. the paediatrician's name). */
    approvedBy: text(),
    approvedOn: date({ mode: 'string' }),
    isActive: boolean().notNull().default(true),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('drug_paeds_rule_generic_key')
      .on(t.facilityId, t.genericName)
      .where(sql`${t.status} = 'active'`),
    check('drug_paeds_rule_range', sql`${t.mgPerKgMin} > 0 and ${t.mgPerKgMax} >= ${t.mgPerKgMin}`),
    check(
      'drug_paeds_rule_lower',
      sql`${t.genericName} = lower(btrim(${t.genericName})) and ${t.genericName} <> ''`,
    ),
    ...cancelChecks('drug_paeds_rule', t),
  ],
);

/** What a patient agreed to (docs/21 §2). The latest row of a kind decides; rows are never edited. */
export const patientConsent = pgTable(
  'patient_consent',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    kind: text().notNull(),
    granted: boolean().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    capturedBy: uuid().references(() => appUser.id),
    method: text().notNull(),
    ...auditColumns(),
  },
  (t) => [
    index('patient_consent_patient_idx').on(t.patientId, t.kind, t.at.desc()),
    check('patient_consent_kind', sqlIn(t.kind, CONSENT_KINDS)),
    check('patient_consent_method', sqlIn(t.method, CONSENT_METHODS)),
  ],
);

/**
 * Messages waiting to go out (docs/21 §4, docs/04 §13). The counter never waits for the internet
 * (AGENTS.md rule 11): rows are queued here and the worker sends them when it can (MSG-01 adds the
 * sender, templates and retries). `dedupe_key` keeps one live message per template, patient and
 * entity.
 */
export const messageOutbox = pgTable(
  'message_outbox',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    channel: text().notNull().default('whatsapp'),
    /** `vaccine_reminder` (docs/04 §13 `message_template.kind`). */
    templateKind: text().notNull(),
    toMobile: text().notNull(),
    language: text().notNull().default('hi'),
    variables: jsonb().notNull(),
    dedupeKey: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: smallint().notNull().default(0),
    lastError: text(),
    providerMessageId: text(),
    sendAfter: timestamp({ withTimezone: true }).notNull(),
    cancelReason: text(),
    /** What the message is about (bill collection, note, pregnancy …): the 24 h de-duplication scope. */
    entityId: uuid(),
    /** PDF to upload and send with the message (docs/21 §4). */
    documentId: uuid().references(() => document.id),
    /** When the current attempt was claimed by a worker (`sending`). */
    claimedAt: timestamp({ withTimezone: true }),
    /** First claim: the 48 h retry window runs from here (docs/21 §4). */
    firstAttemptAt: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('message_outbox_dedupe_key')
      .on(t.facilityId, t.dedupeKey)
      .where(sql`${t.status} = 'queued'`),
    index('message_outbox_due_idx').on(t.status, t.sendAfter),
    index('message_outbox_patient_idx').on(t.patientId, t.createdAt.desc()),
    check('message_outbox_channel', sqlIn(t.channel, ['whatsapp', 'sms'])),
    check('message_outbox_status', sqlIn(t.status, MESSAGE_OUTBOX_STATUSES)),
    check('message_outbox_language', sqlIn(t.language, ['en', 'hi'])),
  ],
);

/** Provider templates (docs/04 §13): the approved name per kind and language. */
export const messageTemplate = pgTable(
  'message_template',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    channel: text().notNull().default('whatsapp'),
    kind: text().notNull(),
    language: text().notNull(),
    providerTemplateName: text().notNull(),
    bodyPreview: text().notNull(),
    variables: jsonb().$type<string[]>().notNull(),
    /** Set once Meta has approved the template; nothing is sent with an unapproved one. */
    isApproved: boolean().notNull().default(false),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('message_template_key').on(t.facilityId, t.channel, t.kind, t.language),
    check('message_template_channel', sqlIn(t.channel, ['whatsapp', 'sms'])),
    check('message_template_language', sqlIn(t.language, ['en', 'hi'])),
  ],
);

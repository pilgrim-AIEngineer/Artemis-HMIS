/**
 * OPD clinical records from Rx transcription (OPD-02 … OPD-04, docs/04 §5, docs/11 §2): the
 * prescription with its rows, the clinical orders that flow to billing, the visit note with the
 * follow-up date, and the autosaved draft of the transcription screen. Nothing is deleted
 * (AGENTS.md rule 4): a correction inserts a new version and marks the old one `superseded`; an
 * order that is no longer wanted is `cancelled` with a reason.
 */
import {
  DRUG_FORMS,
  DURATION_UNITS,
  FREQUENCY_CODES,
  NOTE_STATUSES,
  ORDER_KINDS,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  RX_DRAFT_STATUSES,
  RX_ROUTES,
  RX_SOURCES,
  RX_STATUSES,
  RX_TIMINGS,
  type RxDraftPayload,
  type RxWarning,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { billLine } from './billing';
import { auditColumns, idColumn, sqlIn } from './columns';
import { doctorProfile, drug, labTest, service, usgProcedure } from './masters';
import { patient } from './patient';
import { appUser, document, facilityRef } from './platform';
import { encounter } from './visit';

const nullOrIn = (col: AnyPgColumn, values: readonly string[]) =>
  sql`${col} is null or ${sqlIn(col, values)}`;

export const prescription = pgTable(
  'prescription',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** The doctor who wrote the paper Rx (the visit's doctor). */
    doctorId: uuid()
      .notNull()
      .references(() => doctorProfile.id),
    source: text().notNull().default('transcribed_from_paper'),
    status: text().notNull().default('final'),
    /** 1 for the first transcription of the visit; a correction is the next version. */
    version: integer().notNull().default(1),
    supersedesId: uuid().references((): AnyPgColumn => prescription.id),
    supersededAt: timestamp({ withTimezone: true }),
    enteredBy: uuid()
      .notNull()
      .references(() => appUser.id),
    enteredAt: timestamp({ withTimezone: true }).notNull(),
    /** Picked for the doctor's verification queue by `rx.verifyMode` (Q15). */
    needsVerification: boolean().notNull().default(false),
    verifiedBy: uuid().references(() => appUser.id),
    verifiedAt: timestamp({ withTimezone: true }),
    /** Non-blocking warnings shown when it was saved (docs/11 §2.3). */
    warnings: jsonb()
      .$type<RxWarning[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The photo of the paper sheet this is a transcription of (medico-legal, docs/11 §2.7). */
    paperScanDocumentId: uuid().references(() => document.id),
    notes: text(),
    /** `rx_template` arrives with doctor templates; no FK until then. */
    rxTemplateId: uuid(),
    cancelReason: text(),
    cancelledBy: uuid().references(() => appUser.id),
    cancelledAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    // One current Rx per visit; earlier versions are `superseded`.
    uniqueIndex('prescription_current_key')
      .on(t.encounterId)
      .where(sql`${t.status} in ('final', 'verified')`),
    index('prescription_patient_idx').on(t.patientId, t.enteredAt.desc()),
    index('prescription_doctor_idx').on(t.doctorId, t.enteredAt.desc()),
    index('prescription_verify_idx')
      .on(t.facilityId, t.enteredAt)
      .where(sql`${t.status} = 'final' and ${t.needsVerification}`),
    check('prescription_source', sqlIn(t.source, RX_SOURCES)),
    check('prescription_status', sqlIn(t.status, RX_STATUSES)),
    check('prescription_version_positive', sql`${t.version} >= 1`),
    check('prescription_warnings_array', sql`jsonb_typeof(${t.warnings}) = 'array'`),
    check(
      'prescription_superseded_fields',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    check(
      'prescription_verified_fields',
      sql`(${t.verifiedAt} is null) = (${t.verifiedBy} is null)
        and (${t.status} <> 'verified' or ${t.verifiedAt} is not null)`,
    ),
    check(
      'prescription_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`,
    ),
  ],
);

export const prescriptionItem = pgTable(
  'prescription_item',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    seq: integer().notNull(),
    drugId: uuid().references(() => drug.id),
    /** Typed for a drug not in the master; flagged for the admin to map later (docs/11 §2.3). */
    freeTextDrug: text(),
    /** Name as shown when it was saved (the master's brand + strength, or the free text). */
    drugName: text().notNull(),
    form: text(),
    doseText: text(),
    frequencyCode: text(),
    pattern: text(),
    timing: text(),
    route: text(),
    durationValue: smallint(),
    durationUnit: text(),
    quantityCalc: numeric({ precision: 12, scale: 3 }),
    instructionsEn: text(),
    instructionsHi: text(),
    /** The shorthand line the row was parsed from, so nothing typed is lost (docs/11 §5). */
    sourceLine: text(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('prescription_item_seq_key').on(t.prescriptionId, t.seq),
    index('prescription_item_drug_idx').on(t.drugId),
    check('prescription_item_drug', sql`${t.drugId} is not null or ${t.freeTextDrug} is not null`),
    check('prescription_item_form', nullOrIn(t.form, DRUG_FORMS)),
    check('prescription_item_frequency', nullOrIn(t.frequencyCode, FREQUENCY_CODES)),
    check('prescription_item_timing', nullOrIn(t.timing, RX_TIMINGS)),
    check('prescription_item_route', nullOrIn(t.route, RX_ROUTES)),
    check('prescription_item_duration_unit', nullOrIn(t.durationUnit, DURATION_UNITS)),
    check(
      'prescription_item_duration_pair',
      sql`(${t.durationValue} is null) = (${t.durationUnit} is null) and (${t.durationValue} is null or ${t.durationValue} > 0)`,
    ),
    check(
      'prescription_item_qty_nonnegative',
      sql`${t.quantityCalc} is null or ${t.quantityCalc} >= 0`,
    ),
  ],
);

export const clinicalOrder = pgTable(
  'clinical_order',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** The transcription that placed the order (null for orders from other screens later). */
    prescriptionId: uuid().references(() => prescription.id),
    kind: text().notNull(),
    /** The billing service; null only for admission advice (no charge of its own). */
    serviceId: uuid().references(() => service.id),
    labTestId: uuid().references(() => labTest.id),
    /** `lab_panel` arrives with LAB-01; no FK until then. */
    labPanelId: uuid(),
    usgProcedureId: uuid().references(() => usgProcedure.id),
    priority: text().notNull().default('routine'),
    notes: text(),
    /** Admission advice: the expected admission date (docs/11 §2.4). */
    expectedDate: date({ mode: 'string' }),
    status: text().notNull().default('ordered'),
    orderedBy: uuid().references(() => doctorProfile.id),
    enteredBy: uuid()
      .notNull()
      .references(() => appUser.id),
    /** The active bill line charging this order (cleared when the line is removed from a draft). */
    billLineId: uuid().references((): AnyPgColumn => billLine.id),
    billedAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    cancelledBy: uuid().references(() => appUser.id),
    cancelledAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    index('clinical_order_encounter_idx').on(t.encounterId, t.status),
    index('clinical_order_status_idx').on(t.facilityId, t.kind, t.status),
    // One live order per service per visit (a repeat tick is the same order).
    uniqueIndex('clinical_order_service_key')
      .on(t.encounterId, t.serviceId)
      .where(sql`${t.status} <> 'cancelled' and ${t.serviceId} is not null`),
    uniqueIndex('clinical_order_admission_key')
      .on(t.encounterId)
      .where(sql`${t.status} <> 'cancelled' and ${t.kind} = 'admission'`),
    check('clinical_order_kind', sqlIn(t.kind, ORDER_KINDS)),
    check('clinical_order_status', sqlIn(t.status, ORDER_STATUSES)),
    check('clinical_order_priority', sqlIn(t.priority, ORDER_PRIORITIES)),
    check('clinical_order_service_kind', sql`(${t.kind} = 'admission') = (${t.serviceId} is null)`),
    check(
      'clinical_order_expected_date',
      sql`${t.expectedDate} is null or ${t.kind} = 'admission'`,
    ),
    check(
      'clinical_order_billed_fields',
      sql`${t.status} <> 'billed' or (${t.billLineId} is not null and ${t.billedAt} is not null)`,
    ),
    check(
      'clinical_order_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`,
    ),
  ],
);

export const clinicalNote = pgTable(
  'clinical_note',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    prescriptionId: uuid().references(() => prescription.id),
    kind: text().notNull().default('opd'),
    /** `[{ text }]` (docs/04 §5). */
    complaints: jsonb()
      .$type<{ text: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    history: text(),
    examination: jsonb(),
    /** `[{ text, icd10? }]` */
    provisionalDiagnosis: jsonb()
      .$type<{ text: string; icd10?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    advice: text(),
    followUpDate: date({ mode: 'string' }),
    status: text().notNull().default('final'),
    supersededAt: timestamp({ withTimezone: true }),
    enteredBy: uuid()
      .notNull()
      .references(() => appUser.id),
    verifiedBy: uuid().references(() => appUser.id),
    verifiedAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('clinical_note_current_key')
      .on(t.encounterId, t.kind)
      .where(sql`${t.status} = 'final'`),
    index('clinical_note_follow_up_idx')
      .on(t.facilityId, t.followUpDate)
      .where(sql`${t.status} = 'final' and ${t.followUpDate} is not null`),
    check(
      'clinical_note_kind',
      sqlIn(t.kind, ['opd', 'ipd_progress', 'ipd_admission', 'procedure']),
    ),
    check('clinical_note_status', sqlIn(t.status, NOTE_STATUSES)),
    check('clinical_note_complaints_array', sql`jsonb_typeof(${t.complaints}) = 'array'`),
    check('clinical_note_diagnosis_array', sql`jsonb_typeof(${t.provisionalDiagnosis}) = 'array'`),
    check(
      'clinical_note_superseded_fields',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
  ],
);

/**
 * Server copy of the transcription screen's draft (docs/01 §3: every 20 s; the browser keeps its
 * own copy every 5 s). One row per visit, overwritten by each autosave; `used` once the Rx is
 * saved, `discarded` when the assistant starts over.
 */
export const rxDraft = pgTable(
  'rx_draft',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    payload: jsonb().$type<RxDraftPayload>().notNull(),
    savedAt: timestamp({ withTimezone: true }).notNull(),
    savedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    status: text().notNull().default('open'),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('rx_draft_encounter_key').on(t.encounterId),
    check('rx_draft_status', sqlIn(t.status, RX_DRAFT_STATUSES)),
    check('rx_draft_payload_object', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);

/**
 * Antenatal care (OPD-05, docs/04 §5, docs/11 §3): the pregnancy record, earlier pregnancies
 * (G P A L), ANC visits, the schedule master and its per-pregnancy marks, and the patient alert.
 * One `active` pregnancy per patient (docs/04 §15.4). Rows are closed or cancelled, never deleted
 * (AGENTS.md rule 4). The only facts about the baby are the number of babies and the routine
 * heart rate / fundal height of the examination (AGENTS.md rule 7). An MTP closing is stored as
 * status `mtp` and shown to everyone without MTP permission as "closed" (docs/11 §3.1).
 */
import {
  ANC_SCHEDULE_KINDS,
  BLOOD_GROUPS,
  ANC_SCHEDULE_STATUSES,
  DATING_BASES,
  OB_OUTCOMES,
  PLURALITIES,
  PREGNANCY_STATUSES,
  PRESENTATIONS,
  type RiskCode,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
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
import { appUser, facilityRef } from './platform';
import { encounter } from './visit';

const DIPSTICK = ['nil', 'trace', 'plus1', 'plus2', 'plus3', 'plus4'] as const;
const BLOOD_GROUP_LIST = sql.raw(`(${BLOOD_GROUPS.map((g) => `'${g}'`).join(', ')})`);

export interface ManualRisk {
  code: RiskCode;
  text?: string | null;
}

export const pregnancy = pgTable(
  'pregnancy',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** Null when the LMP is unknown; the pregnancy is then dated by scan. */
    lmp: date({ mode: 'string' }),
    /** `lmp + 280 days`. */
    eddByLmp: date({ mode: 'string' }),
    eddByScan: date({ mode: 'string' }),
    /** The EDD every GA is counted from; changed only by a confirmed re-dating (audited). */
    eddFinal: date({ mode: 'string' }).notNull(),
    datingBasis: text().notNull(),
    scanDate: date({ mode: 'string' }),
    /** GA in days found at the dating scan. */
    scanGaDays: smallint(),
    /** What was decided about the scan suggestion: `kept_lmp` or `switched_to_scan`; null = none yet. */
    redatingDecision: text(),
    /** First recorded in this hospital; booking tests and Td are due from here. */
    bookingDate: date({ mode: 'string' }).notNull(),
    gravida: smallint().notNull().default(1),
    para: smallint().notNull().default(0),
    abortions: smallint().notNull().default(0),
    living: smallint().notNull().default(0),
    /** The score was typed by hand and is not recomputed from the history. */
    gpalManual: boolean().notNull().default(false),
    plurality: text().notNull().default('single'),
    bloodGroupRh: text(),
    /** Flags a person ticked (gdm, thyroid, …); the automatic ones are computed on read. */
    manualRisks: jsonb()
      .$type<ManualRisk[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text().notNull().default('active'),
    outcomeDate: date({ mode: 'string' }),
    outcomeEncounterId: uuid().references(() => encounter.id),
    closeReason: text(),
    closedBy: uuid().references(() => appUser.id),
    closedAt: timestamp({ withTimezone: true }),
    notes: text(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('pregnancy_one_active_key')
      .on(t.patientId)
      .where(sql`${t.status} = 'active'`),
    index('pregnancy_patient_idx').on(t.patientId, t.createdAt.desc()),
    index('pregnancy_status_edd_idx').on(t.facilityId, t.status, t.eddFinal),
    check('pregnancy_status', sqlIn(t.status, PREGNANCY_STATUSES)),
    check('pregnancy_dating_basis', sqlIn(t.datingBasis, DATING_BASES)),
    check('pregnancy_plurality', sqlIn(t.plurality, PLURALITIES)),
    check(
      'pregnancy_blood_group',
      sql`${t.bloodGroupRh} is null or ${t.bloodGroupRh} in ${BLOOD_GROUP_LIST}`,
    ),
    check(
      'pregnancy_redating_decision',
      sql`${t.redatingDecision} is null or ${t.redatingDecision} in ('kept_lmp', 'switched_to_scan')`,
    ),
    check('pregnancy_manual_risks_array', sql`jsonb_typeof(${t.manualRisks}) = 'array'`),
    check(
      'pregnancy_lmp_edd',
      sql`(${t.lmp} is null) = (${t.eddByLmp} is null) and (${t.lmp} is null or ${t.eddByLmp} = ${t.lmp} + 280)`,
    ),
    check(
      'pregnancy_scan_fields',
      sql`(${t.scanDate} is null) = (${t.scanGaDays} is null) and (${t.scanDate} is null) = (${t.eddByScan} is null)`,
    ),
    check(
      'pregnancy_dating_source',
      sql`(${t.datingBasis} = 'lmp' and ${t.lmp} is not null and ${t.eddFinal} = ${t.eddByLmp})
        or (${t.datingBasis} = 'scan' and ${t.eddByScan} is not null and ${t.eddFinal} = ${t.eddByScan})`,
    ),
    check(
      'pregnancy_closed_fields',
      sql`(${t.status} = 'active') = (${t.outcomeDate} is null and ${t.closedAt} is null)`,
    ),
    check(
      'pregnancy_gpal',
      sql`${t.gravida} >= 1 and ${t.para} >= 0 and ${t.abortions} >= 0 and ${t.living} >= 0`,
    ),
  ],
);

/** An earlier pregnancy of the patient (docs/04 §5 `obstetric_history`); replaced, never deleted. */
export const obstetricHistory = pgTable(
  'obstetric_history',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    pregnancyNo: smallint().notNull(),
    year: smallint(),
    /** MTP is not a value here: it belongs to the restricted register. */
    outcome: text().notNull(),
    gestationWeeks: smallint(),
    place: text(),
    complications: text(),
    /** Babies from this pregnancy alive today (twins can be 2). Replaces `baby_alive` of docs/04. */
    babiesAlive: smallint().notNull().default(0),
    neonatalDeath: boolean().notNull().default(false),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    index('obstetric_history_patient_idx').on(t.patientId, t.pregnancyNo),
    check('obstetric_history_outcome', sqlIn(t.outcome, OB_OUTCOMES)),
    check('obstetric_history_babies', sql`${t.babiesAlive} between 0 and 4`),
    ...cancelChecks('obstetric_history', t),
  ],
);

/** One ANC visit; vitals fill the first columns, the assistant adds the rest (docs/11 §3.3). */
export const ancVisit = pgTable(
  'anc_visit',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    pregnancyId: uuid()
      .notNull()
      .references(() => pregnancy.id),
    encounterId: uuid().references(() => encounter.id),
    visitDate: date({ mode: 'string' }).notNull(),
    /** GA in days on the visit date, from the EDD in force when the visit was saved. */
    gaDays: smallint().notNull(),
    weightKg: numeric({ precision: 5, scale: 2 }),
    bpSys: smallint(),
    bpDia: smallint(),
    fundalHeightCm: numeric({ precision: 3, scale: 1 }),
    fhr: smallint(),
    presentation: text(),
    oedema: text(),
    urineProtein: text(),
    urineSugar: text(),
    hb: numeric({ precision: 3, scale: 1 }),
    remarks: text(),
    ...cancelColumns(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('anc_visit_pregnancy_date_key')
      .on(t.pregnancyId, t.visitDate)
      .where(sql`${t.status} = 'active'`),
    index('anc_visit_encounter_idx').on(t.encounterId),
    check(
      'anc_visit_presentation',
      sql`${t.presentation} is null or ${sqlIn(t.presentation, PRESENTATIONS)}`,
    ),
    check(
      'anc_visit_oedema',
      sql`${t.oedema} is null or ${t.oedema} in ('none', 'plus1', 'plus2')`,
    ),
    check(
      'anc_visit_urine_protein',
      sql`${t.urineProtein} is null or ${sqlIn(t.urineProtein, DIPSTICK)}`,
    ),
    check(
      'anc_visit_urine_sugar',
      sql`${t.urineSugar} is null or ${sqlIn(t.urineSugar, DIPSTICK)}`,
    ),
    check(
      'anc_visit_bp_pair',
      sql`(${t.bpSys} is null) = (${t.bpDia} is null) and (${t.bpDia} is null or ${t.bpDia} < ${t.bpSys})`,
    ),
    ...cancelChecks('anc_visit', t),
  ],
);

/** Schedule master (docs/33 §4, seeded; the gynaecologist edits it). */
export const ancScheduleItem = pgTable(
  'anc_schedule_item',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    code: text().notNull(),
    label: text().notNull(),
    labelHi: text().notNull(),
    kind: text().notNull(),
    gaFromDays: smallint().notNull().default(0),
    gaToDays: smallint(),
    /** Due from the booking visit, overdue after the grace days (setting `anc.bookingGraceDays`). */
    atBooking: boolean().notNull().default(false),
    rhNegativeOnly: boolean().notNull().default(false),
    /** Becomes due `afterDays` after the item with this code was done (Td-2 after Td-1). */
    afterCode: text(),
    afterDays: smallint().notNull().default(0),
    /** Service codes whose completed order marks the item done. */
    serviceCodes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sortOrder: smallint().notNull().default(0),
    isActive: boolean().notNull().default(true),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('anc_schedule_item_code_key').on(t.facilityId, t.code),
    check('anc_schedule_item_kind', sqlIn(t.kind, ANC_SCHEDULE_KINDS)),
    check(
      'anc_schedule_item_window',
      sql`${t.gaFromDays} >= 0 and (${t.gaToDays} is null or ${t.gaToDays} >= ${t.gaFromDays})`,
    ),
  ],
);

/** What was done or skipped for one pregnancy and schedule item. `due` = marked again as not done. */
export const ancScheduleStatus = pgTable(
  'anc_schedule_status',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    pregnancyId: uuid()
      .notNull()
      .references(() => pregnancy.id),
    scheduleItemId: uuid()
      .notNull()
      .references(() => ancScheduleItem.id),
    status: text().notNull(),
    doneDate: date({ mode: 'string' }),
    encounterId: uuid().references(() => encounter.id),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('anc_schedule_status_key').on(t.pregnancyId, t.scheduleItemId),
    check('anc_schedule_status_status', sqlIn(t.status, ANC_SCHEDULE_STATUSES)),
    check(
      'anc_schedule_status_done_date',
      sql`(${t.status} = 'done') = (${t.doneDate} is not null)`,
    ),
  ],
);

/** Alerts shown on the patient header (docs/04 §3). OPD-05 raises `high_risk_pregnancy`. */
export const patientAlert = pgTable(
  'patient_alert',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    kind: text().notNull(),
    text: text().notNull(),
    /** Machine-readable cause (the risk codes), so screens can word it in either language. */
    details: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    pregnancyId: uuid().references(() => pregnancy.id),
    active: boolean().notNull().default(true),
    resolvedAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('patient_alert_pregnancy_key')
      .on(t.pregnancyId)
      .where(sql`${t.active} and ${t.kind} = 'high_risk_pregnancy'`),
    index('patient_alert_patient_idx').on(t.patientId, t.active),
    check(
      'patient_alert_kind',
      sqlIn(t.kind, ['high_risk_pregnancy', 'allergy', 'vip', 'mlc', 'other']),
    ),
    check('patient_alert_resolved', sql`${t.active} = (${t.resolvedAt} is null)`),
  ],
);

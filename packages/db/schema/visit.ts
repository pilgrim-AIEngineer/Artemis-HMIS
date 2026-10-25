/**
 * OPD encounters and the daily token queue (docs/04 §4, REG-03, REG-04). An `encounter` is a
 * visit; the consultation fee is snapshotted on it (service, paise, why) until the draft bill
 * lands in BIL-01. `opd_token` is unique per doctor per IST day; `queue_event` is the append-only
 * transition log that feeds wait-time analytics. Rows are cancelled, never deleted (rule 4).
 */
import {
  ENCOUNTER_STATUSES,
  ENCOUNTER_TYPES,
  FEE_BASES,
  QUEUE_PRIORITIES,
  QUEUE_STATES,
  TOKEN_ISSUE_BASES,
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
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, idColumn, sqlIn } from './columns';
import { department, doctorProfile, payer, service, tariff } from './masters';
import { patient } from './patient';
import { appUser, facilityRef } from './platform';

/** D-6: hard per-row ceiling for money columns (₹1,000 crore in paise). */
const MONEY_CEILING = 1_000_000_000_000n;

export const encounter = pgTable(
  'encounter',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    type: text().notNull().default('opd'),
    /** `OP/26-27/004512`, from the `opd_visit` series (FY reset). */
    number: text().notNull(),
    doctorId: uuid()
      .notNull()
      .references(() => doctorProfile.id),
    departmentId: uuid()
      .notNull()
      .references(() => department.id),
    payerId: uuid()
      .notNull()
      .references(() => payer.id),
    tariffId: uuid()
      .notNull()
      .references(() => tariff.id),
    visitType: text().notNull(),
    chiefComplaintShort: text(),
    /** Queue priority chosen at the desk; carried to the token whenever it is issued. */
    priority: text().notNull().default('normal'),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** IST calendar day of `started_at`: follow-up windows and the daily queue key on it. */
    visitDate: date({ mode: 'string' }).notNull(),
    endedAt: timestamp({ withTimezone: true }),
    status: text().notNull().default('open'),
    cancelReason: text(),
    cancelledBy: uuid().references(() => appUser.id),
    cancelledAt: timestamp({ withTimezone: true }),
    isRestricted: boolean().notNull().default(false),
    referralSource: text(),
    isDowntimeEntry: boolean().notNull().default(false),
    /** Consultation fee snapshot (rate of the tariff on the visit day); the bill reads it. */
    consultationServiceId: uuid().references(() => service.id),
    consultationFeePaise: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    feeBasis: text().notNull(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('encounter_number_key').on(t.facilityId, t.number),
    index('encounter_patient_idx').on(t.patientId, t.startedAt.desc()),
    index('encounter_doctor_idx').on(t.doctorId, t.startedAt),
    index('encounter_follow_up_idx').on(t.patientId, t.doctorId, t.visitDate),
    check('encounter_type', sqlIn(t.type, ENCOUNTER_TYPES)),
    check('encounter_status', sqlIn(t.status, ENCOUNTER_STATUSES)),
    check('encounter_priority', sqlIn(t.priority, QUEUE_PRIORITIES)),
    check('encounter_visit_type', sqlIn(t.visitType, VISIT_TYPES)),
    check('encounter_fee_basis', sqlIn(t.feeBasis, FEE_BASES)),
    check(
      'encounter_fee_range',
      sql`${t.consultationFeePaise} >= 0 and ${t.consultationFeePaise} <= ${sql.raw(String(MONEY_CEILING))}`,
    ),
    check(
      'encounter_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelReason} is not null)`,
    ),
  ],
);

export const opdToken = pgTable(
  'opd_token',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    doctorId: uuid()
      .notNull()
      .references(() => doctorProfile.id),
    /** IST calendar day the token was issued for. */
    tokenDate: date({ mode: 'string' }).notNull(),
    tokenNo: integer().notNull(),
    priority: text().notNull().default('normal'),
    queueState: text().notNull().default('waiting'),
    /** Position inside the priority class: `token_no * 1000`; "skip" renumbers it. */
    queueOrder: integer().notNull(),
    /** Why the token was issued (free fee, setting, payment, or a manual issue before payment). */
    issuedBasis: text().notNull(),
    issuedAt: timestamp({ withTimezone: true }).notNull(),
    vitalsAt: timestamp({ withTimezone: true }),
    calledAt: timestamp({ withTimezone: true }),
    seenAt: timestamp({ withTimezone: true }),
    doneAt: timestamp({ withTimezone: true }),
    recallCount: integer().notNull().default(0),
    /** Required reason for `no_show` and `cancelled`. */
    stateReason: text(),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('opd_token_number_key').on(t.doctorId, t.tokenDate, t.tokenNo),
    uniqueIndex('opd_token_encounter_key').on(t.encounterId),
    index('opd_token_day_state_idx').on(t.facilityId, t.tokenDate, t.queueState),
    check('opd_token_priority', sqlIn(t.priority, QUEUE_PRIORITIES)),
    check('opd_token_state', sqlIn(t.queueState, QUEUE_STATES)),
    check('opd_token_issued_basis', sqlIn(t.issuedBasis, TOKEN_ISSUE_BASES)),
    check('opd_token_no_positive', sql`${t.tokenNo} >= 1`),
    check(
      'opd_token_state_reason',
      sql`${t.queueState} not in ('no_show', 'cancelled') or ${t.stateReason} is not null`,
    ),
  ],
);

export const queueEvent = pgTable(
  'queue_event',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    tokenId: uuid()
      .notNull()
      .references(() => opdToken.id),
    fromState: text(),
    toState: text().notNull(),
    byUser: uuid().references(() => appUser.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** `skip`, `recall`, `transfer`, `priority`, `auto_no_show` … (no patient data). */
    action: text().notNull(),
    ...auditColumns(),
  },
  (t) => [
    index('queue_event_token_idx').on(t.tokenId, t.at),
    index('queue_event_at_idx').on(t.facilityId, t.at),
    check('queue_event_from', sql`${t.fromState} is null or ${sqlIn(t.fromState, QUEUE_STATES)}`),
    check('queue_event_to', sqlIn(t.toState, QUEUE_STATES)),
  ],
);

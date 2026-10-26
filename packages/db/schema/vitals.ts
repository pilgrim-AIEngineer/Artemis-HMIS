/**
 * Vitals taken at the vitals desk (OPD-01, docs/04 §4, docs/11 §1). One `active` row per
 * encounter; a correction inserts a new row and marks the old one `superseded` (AGENTS.md rule 4),
 * so earlier readings stay on record. Temperature is stored in °C (entered in °F); `flags` holds
 * the out-of-range bands judged when the row was saved. Nothing here describes a fetus beyond the
 * heart rate and fundal height of the routine antenatal examination (AGENTS.md rule 7).
 */
import {
  DIPSTICK_GRADES,
  OEDEMA_GRADES,
  VITALS_GROUPS,
  VITALS_STATUSES,
  type VitalsFlag,
} from '@hmis/shared';
import { sql } from 'drizzle-orm';
import {
  check,
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
import { auditColumns, idColumn, sqlIn } from './columns';
import { encounter } from './visit';
import { patient } from './patient';
import { appUser, facilityRef } from './platform';

export const vitals = pgTable(
  'vitals',
  {
    id: idColumn(),
    facilityId: facilityRef(),
    encounterId: uuid()
      .notNull()
      .references(() => encounter.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** Form used: adult, pregnant or child (docs/11 §1). */
    formGroup: text().notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull(),
    bpSys: smallint(),
    bpDia: smallint(),
    pulse: smallint(),
    /** Two decimals, so a °F entry (one decimal) converts back to exactly what was typed. */
    tempC: numeric({ precision: 5, scale: 2 }),
    spo2: smallint(),
    rr: smallint(),
    weightKg: numeric({ precision: 5, scale: 2 }),
    heightCm: numeric({ precision: 4, scale: 1 }),
    bmi: numeric({ precision: 4, scale: 1 }),
    headCircCm: numeric({ precision: 3, scale: 1 }),
    muacCm: numeric({ precision: 3, scale: 1 }),
    rbsMgdl: smallint(),
    hbGdl: numeric({ precision: 3, scale: 1 }),
    painScore: smallint(),
    fundalHeightCm: numeric({ precision: 3, scale: 1 }),
    fhr: smallint(),
    oedema: text(),
    urineAlbumin: text(),
    urineSugar: text(),
    recordedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    flags: jsonb()
      .$type<VitalsFlag[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text().notNull().default('active'),
    supersededAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('vitals_active_encounter_key')
      .on(t.encounterId)
      .where(sql`${t.status} = 'active'`),
    index('vitals_encounter_idx').on(t.encounterId, t.recordedAt),
    index('vitals_patient_idx').on(t.patientId, t.recordedAt.desc()),
    check('vitals_group', sqlIn(t.formGroup, VITALS_GROUPS)),
    check('vitals_status', sqlIn(t.status, VITALS_STATUSES)),
    check('vitals_oedema', sql`${t.oedema} is null or ${sqlIn(t.oedema, OEDEMA_GRADES)}`),
    check(
      'vitals_urine_albumin',
      sql`${t.urineAlbumin} is null or ${sqlIn(t.urineAlbumin, DIPSTICK_GRADES)}`,
    ),
    check(
      'vitals_urine_sugar',
      sql`${t.urineSugar} is null or ${sqlIn(t.urineSugar, DIPSTICK_GRADES)}`,
    ),
    check('vitals_flags_array', sql`jsonb_typeof(${t.flags}) = 'array'`),
    check(
      'vitals_superseded_fields',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`,
    ),
    check(
      'vitals_bp_pair',
      sql`(${t.bpSys} is null) = (${t.bpDia} is null) and (${t.bpDia} is null or ${t.bpDia} < ${t.bpSys})`,
    ),
  ],
);

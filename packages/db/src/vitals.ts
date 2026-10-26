/**
 * Vitals desk (OPD-01, docs/11 §1): the list of patients waiting for vitals, the form context
 * (group, previous height, thresholds), saving a reading and the OPD-sheet read. Saving is one
 * transaction: the reading, the superseded earlier reading (a correction never overwrites,
 * AGENTS.md rule 4) and the token's move `waiting` → `vitals_done` with its queue event.
 */
import {
  ageFromDob,
  allowedVitalsGroups,
  celsiusToFahrenheit,
  defaultVitalsGroup,
  evaluateVitals,
  heightDue,
  istDateString,
  normaliseVitals,
  parseVitalsFlags,
  priorityRank,
  validateVitals,
  type Age,
  type DipstickGrade,
  type OedemaGrade,
  type PriorityClass,
  type QueuePriority,
  type QueueState,
  type RecordVitalsInput,
  type StoredVitals,
  type VisitType,
  type VitalsFlag,
  type VitalsGroup,
  type VitalsThresholds,
} from '@hmis/shared';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { doctorProfile, encounter, opdToken, patient, vitals } from '../schema';
import type { Db } from './client';
import { activePregnancyId, syncAncVisitFromVitals } from './anc';
import { advanceToken } from './queue';
import { readSetting, readSettings } from './settings';
import type { Tx } from './tx';
import { VisitInputError, type Actor } from './visits';

type Queryable = Db | Tx;
type VitalsRow = typeof vitals.$inferSelect;

/** Token states in which a reading may still be taken or corrected. */
const OPEN_STATES: readonly QueueState[] = ['waiting', 'vitals_done', 'with_doctor'];

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** A saved reading with numbers as numbers and temperature in both units. */
export interface VitalsRecord extends StoredVitals {
  id: string;
  group: VitalsGroup;
  recordedAt: Date;
  tempF: number | null;
  flags: VitalsFlag[];
}

function toRecord(r: VitalsRow): VitalsRecord {
  const tempC = num(r.tempC);
  return {
    id: r.id,
    group: r.formGroup as VitalsGroup,
    recordedAt: r.recordedAt,
    bpSys: r.bpSys,
    bpDia: r.bpDia,
    pulse: r.pulse,
    tempC,
    tempF: tempC === null ? null : celsiusToFahrenheit(tempC),
    spo2: r.spo2,
    rr: r.rr,
    weightKg: num(r.weightKg),
    heightCm: num(r.heightCm),
    bmi: num(r.bmi),
    headCircCm: num(r.headCircCm),
    muacCm: num(r.muacCm),
    rbsMgdl: r.rbsMgdl,
    fundalHeightCm: num(r.fundalHeightCm),
    fhr: r.fhr,
    oedema: r.oedema as OedemaGrade | null,
    urineAlbumin: r.urineAlbumin as DipstickGrade | null,
    urineSugar: r.urineSugar as DipstickGrade | null,
    flags: parseVitalsFlags(r.flags),
  };
}

/** The current reading of a visit, or null when none was taken. */
export async function activeVitals(
  q: Queryable,
  facilityId: string,
  encounterId: string,
): Promise<VitalsRecord | null> {
  const [row] = await q
    .select()
    .from(vitals)
    .where(
      and(
        eq(vitals.facilityId, facilityId),
        eq(vitals.encounterId, encounterId),
        eq(vitals.status, 'active'),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

// ---------------------------------------------------------------- desk list

export interface VitalsDeskItem {
  tokenId: string;
  encounterId: string;
  tokenNo: number;
  priority: QueuePriority;
  queueState: QueueState;
  visitType: VisitType;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  dob: string;
  sex: string;
  doctor: { displayName: string; displayNameHi: string | null };
  issuedAt: Date;
  vitalsAt: Date | null;
  flags: VitalsFlag[];
}

export interface VitalsDesk {
  date: string;
  /** Not yet measured: priority classes first, then oldest first. */
  waiting: VitalsDeskItem[];
  /** Measured today and still open: a reading can be corrected here. Latest first. */
  done: VitalsDeskItem[];
}

export async function vitalsDesk(tx: Tx, facilityId: string, now: Date): Promise<VitalsDesk> {
  const date = istDateString(now);
  const order = (await readSetting(tx, facilityId, 'queue.priorityOrder')) as PriorityClass[];
  const rows = await tx
    .select({
      tokenId: opdToken.id,
      encounterId: opdToken.encounterId,
      tokenNo: opdToken.tokenNo,
      priority: opdToken.priority,
      queueState: opdToken.queueState,
      visitType: encounter.visitType,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      doctorName: doctorProfile.displayName,
      doctorNameHi: doctorProfile.displayNameHi,
      issuedAt: opdToken.issuedAt,
      vitalsAt: opdToken.vitalsAt,
      flags: vitals.flags,
    })
    .from(opdToken)
    .innerJoin(encounter, eq(encounter.id, opdToken.encounterId))
    .innerJoin(patient, eq(patient.id, encounter.patientId))
    .innerJoin(doctorProfile, eq(doctorProfile.id, opdToken.doctorId))
    .leftJoin(
      vitals,
      and(eq(vitals.encounterId, opdToken.encounterId), eq(vitals.status, 'active')),
    )
    .where(
      and(
        eq(opdToken.facilityId, facilityId),
        eq(opdToken.tokenDate, date),
        inArray(opdToken.queueState, ['waiting', 'vitals_done']),
      ),
    );
  const items: VitalsDeskItem[] = rows.map((r) => ({
    tokenId: r.tokenId,
    encounterId: r.encounterId,
    tokenNo: r.tokenNo,
    priority: r.priority as QueuePriority,
    queueState: r.queueState as QueueState,
    visitType: r.visitType as VisitType,
    uhid: r.uhid,
    fullName: r.fullName,
    nameHi: r.nameHi,
    dob: r.dob,
    sex: r.sex,
    doctor: { displayName: r.doctorName, displayNameHi: r.doctorNameHi },
    issuedAt: r.issuedAt,
    vitalsAt: r.vitalsAt,
    flags: parseVitalsFlags(r.flags ?? []),
  }));
  return {
    date,
    waiting: items
      .filter((i) => i.queueState === 'waiting')
      .sort(
        (a, b) =>
          priorityRank(a.priority, order) - priorityRank(b.priority, order) ||
          a.issuedAt.getTime() - b.issuedAt.getTime() ||
          a.tokenNo - b.tokenNo,
      ),
    done: items
      .filter((i) => i.queueState === 'vitals_done')
      .sort((a, b) => (b.vitalsAt?.getTime() ?? 0) - (a.vitalsAt?.getTime() ?? 0)),
  };
}

// ---------------------------------------------------------------- form context

export interface VitalsContext {
  token: {
    id: string;
    encounterId: string;
    tokenNo: number;
    queueState: QueueState;
    visitType: VisitType;
    /** Whether the token can still take a reading. */
    open: boolean;
  };
  patient: {
    uhid: string;
    fullName: string;
    nameHi: string | null;
    dob: string;
    sex: string;
    mobileLast4: string | null;
    age: Age;
  };
  allowedGroups: VitalsGroup[];
  defaultGroup: VitalsGroup;
  /** The reading already saved for this visit (correction), if any. */
  current: VitalsRecord | null;
  /** Latest recorded height of this patient (adult / child), for the yearly height prompt. */
  lastHeight: { cm: number; on: string } | null;
  heightDue: boolean;
  thresholds: VitalsThresholds;
  /** True when the ANC visit type, an active pregnancy or an earlier pregnant-form reading suggests the pregnant form. */
  pregnantHint: boolean;
}

/** A pregnant-form reading this recent makes the pregnant form the default (a full term + margin). */
const PREGNANT_HINT_DAYS = 300;

export async function vitalsContext(
  tx: Tx,
  facilityId: string,
  tokenId: string,
  now: Date,
): Promise<VitalsContext> {
  const [row] = await tx
    .select({
      tokenId: opdToken.id,
      encounterId: opdToken.encounterId,
      tokenNo: opdToken.tokenNo,
      queueState: opdToken.queueState,
      encounterStatus: encounter.status,
      visitType: encounter.visitType,
      patientId: patient.id,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      dob: patient.dob,
      sex: patient.sex,
      mobile: patient.mobile,
    })
    .from(opdToken)
    .innerJoin(encounter, eq(encounter.id, opdToken.encounterId))
    .innerJoin(patient, eq(patient.id, encounter.patientId))
    .where(and(eq(opdToken.id, tokenId), eq(opdToken.facilityId, facilityId)));
  if (!row) throw new VisitInputError('queue.tokenNotFound');

  const age = ageFromDob(row.dob, now);
  const who = { age, sex: row.sex };
  const [settings, current, lastHeightRow, recentPregnant] = await Promise.all([
    readSettings(tx, facilityId, ['vitals.thresholds', 'vitals.heightPromptDays']),
    activeVitals(tx, facilityId, row.encounterId),
    tx
      .select({ cm: vitals.heightCm, at: vitals.recordedAt })
      .from(vitals)
      .where(
        and(
          eq(vitals.patientId, row.patientId),
          sql`${vitals.heightCm} is not null`,
          ne(vitals.encounterId, row.encounterId),
        ),
      )
      .orderBy(desc(vitals.recordedAt))
      .limit(1),
    tx
      .select({ id: vitals.id })
      .from(vitals)
      .where(
        and(
          eq(vitals.patientId, row.patientId),
          eq(vitals.formGroup, 'pregnant'),
          sql`${vitals.recordedAt} > ${new Date(now.getTime() - PREGNANT_HINT_DAYS * 86_400_000)}`,
          ne(vitals.encounterId, row.encounterId),
        ),
      )
      .limit(1),
  ]);
  const today = istDateString(now);
  const last = lastHeightRow[0];
  // A correction keeps the form it was saved with; a new reading follows the hint.
  const activePregnancy = await activePregnancyId(tx, facilityId, row.patientId);
  const pregnantHint = current
    ? current.group === 'pregnant'
    : row.visitType === 'anc' || activePregnancy !== null || recentPregnant.length > 0;
  const lastHeight = last?.cm ? { cm: Number(last.cm), on: istDateString(last.at) } : null;
  return {
    token: {
      id: row.tokenId,
      encounterId: row.encounterId,
      tokenNo: row.tokenNo,
      queueState: row.queueState as QueueState,
      visitType: row.visitType as VisitType,
      open: row.encounterStatus === 'open' && OPEN_STATES.includes(row.queueState as QueueState),
    },
    patient: {
      uhid: row.uhid,
      fullName: row.fullName,
      nameHi: row.nameHi,
      dob: row.dob,
      sex: row.sex,
      mobileLast4: row.mobile ? row.mobile.slice(-4) : null,
      age,
    },
    allowedGroups: allowedVitalsGroups(who),
    defaultGroup: current?.group ?? defaultVitalsGroup(who, pregnantHint),
    current,
    lastHeight,
    heightDue: heightDue(lastHeight?.on ?? null, today, settings['vitals.heightPromptDays']),
    thresholds: settings['vitals.thresholds'],
    pregnantHint,
  };
}

// ---------------------------------------------------------------- save

export interface RecordedVitals {
  vitalsId: string;
  tokenId: string;
  encounterId: string;
  tokenNo: number;
  queueState: QueueState;
  flags: VitalsFlag[];
  /** The token moved to `vitals_done` with this save (first reading of the visit). */
  advanced: boolean;
  /** Print the OPD sheet now: first save and `opd.sheetPrintAt` = `vitals`. */
  printSheet: boolean;
}

/**
 * Saves a reading for a token. The first reading moves the token to `vitals_done`; a later one
 * (correction) supersedes the first and keeps the state. Flags are judged on the stored values
 * with the facility's thresholds (docs/11 §1).
 */
export async function recordVitals(
  tx: Tx,
  actor: Actor & { userId: string },
  input: RecordVitalsInput,
  now: Date,
): Promise<RecordedVitals> {
  const [token] = await tx
    .select()
    .from(opdToken)
    .where(and(eq(opdToken.id, input.tokenId), eq(opdToken.facilityId, actor.facilityId)))
    .for('update');
  if (!token) throw new VisitInputError('queue.tokenNotFound');
  const [enc] = await tx
    .select({ id: encounter.id, patientId: encounter.patientId, status: encounter.status })
    .from(encounter)
    .where(eq(encounter.id, token.encounterId));
  const [p] = await tx
    .select({ dob: patient.dob, sex: patient.sex })
    .from(patient)
    .where(eq(patient.id, enc!.patientId));
  if (enc!.status !== 'open' || !OPEN_STATES.includes(token.queueState as QueueState)) {
    throw new VisitInputError('vitals.notAllowed');
  }

  const who = { age: ageFromDob(p!.dob, now), sex: p!.sex };
  if (!allowedVitalsGroups(who).includes(input.group)) {
    throw new VisitInputError('vitals.groupMismatch');
  }
  if (validateVitals(input.group, input.values, who).length > 0) {
    throw new VisitInputError('vitals.invalid');
  }

  const stored = normaliseVitals(input.group, input.values);
  const thresholds = await readSetting(tx, actor.facilityId, 'vitals.thresholds');
  const flags = evaluateVitals(input.group, stored, thresholds);

  await tx
    .update(vitals)
    .set({ status: 'superseded', supersededAt: now })
    .where(and(eq(vitals.encounterId, token.encounterId), eq(vitals.status, 'active')));
  const id = uuidv7();
  const str = (n: number | null) => (n === null ? null : String(n));
  await tx.insert(vitals).values({
    id,
    facilityId: actor.facilityId,
    encounterId: token.encounterId,
    patientId: enc!.patientId,
    formGroup: input.group,
    recordedAt: now,
    bpSys: stored.bpSys,
    bpDia: stored.bpDia,
    pulse: stored.pulse,
    tempC: str(stored.tempC),
    spo2: stored.spo2,
    rr: stored.rr,
    weightKg: str(stored.weightKg),
    heightCm: str(stored.heightCm),
    bmi: str(stored.bmi),
    headCircCm: str(stored.headCircCm),
    muacCm: str(stored.muacCm),
    rbsMgdl: stored.rbsMgdl,
    fundalHeightCm: str(stored.fundalHeightCm),
    fhr: stored.fhr,
    oedema: stored.oedema,
    urineAlbumin: stored.urineAlbumin,
    urineSugar: stored.urineSugar,
    recordedBy: actor.userId,
    flags,
  });

  // With an active pregnancy the readings also fill today's ANC visit row (OPD-05).
  await syncAncVisitFromVitals(
    tx,
    { ...actor, userId: actor.userId, mtp: { view: false, edit: false } },
    {
      encounterId: token.encounterId,
      patientId: enc!.patientId,
      formGroup: input.group,
      visitType: (
        await tx
          .select({ t: encounter.visitType })
          .from(encounter)
          .where(eq(encounter.id, token.encounterId))
      )[0]!.t,
    },
    now,
  );

  const advanced = token.queueState === 'waiting';
  const moved = advanced
    ? await advanceToken(tx, actor, token.id, 'vitals_done', now, 'vitals')
    : token;
  const sheetAt = await readSetting(tx, actor.facilityId, 'opd.sheetPrintAt');
  return {
    vitalsId: id,
    tokenId: token.id,
    encounterId: token.encounterId,
    tokenNo: moved.tokenNo,
    queueState: moved.queueState as QueueState,
    flags,
    advanced,
    printSheet: advanced && sheetAt === 'vitals',
  };
}

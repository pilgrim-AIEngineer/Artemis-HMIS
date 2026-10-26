/**
 * Paediatrics (OPD-06, docs/11 §4): the immunisation card with catch-up, vaccine doses given with
 * their batch, the WhatsApp reminder queued for the next due date, growth measurements with WHO
 * z-scores and chart data, and the paediatrician's weight-based dose rules. Every write is one
 * transaction audited by the table triggers; recording a dose or a measurement is idempotent
 * (AGENTS.md rule 9). Rows are cancelled, never deleted (rule 4). The software calculates and
 * reminds; it never decides what a child should be given.
 */
import {
  checkDoseTiming,
  computeImmunisationSchedule,
  DEFAULT_IMMUNISATION_SCHEDULES,
  dosesDueOn,
  formatDate,
  ageFromDob,
  istDateString,
  nextDueDate,
  reminderSendAt,
  scheduleItemCode,
  WHO_LENGTH_UNTIL_DAYS,
  WHO_MAX_AGE_DAYS,
  zBand,
  addDays,
  daysBetween,
  parseIsoDate,
  toIsoDate,
  type DoseTimingProblem,
  type GrowthIndicator,
  type ImmunisationScheduleName,
  type PaedsDoseRule,
  type PaedsRuleInput,
  type RecordDoseInput,
  type RecordGrowthInput,
  type ScheduleItem,
  type ScheduleRow,
  type StoredZScores,
  type ZBand,
} from '@hmis/shared';
import { computeZScores, growthCurve, type GrowthCurve } from '@hmis/shared/growth';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  drugPaedsRule,
  encounter,
  growthMeasurement,
  immunisationGiven,
  immunisationProfile,
  immunisationSchedule,
  messageOutbox,
  patient,
  patientConsent,
  vitals,
} from '../schema';
import type { Db } from './client';
import { runIdempotent } from './idempotency';
import { readSettings } from './settings';
import type { Tx } from './tx';

type Queryable = Db | Tx;

export type PaedsErrorKey =
  | 'paeds.patientNotFound'
  | 'paeds.scheduleItemNotFound'
  | 'paeds.doseAlreadyGiven'
  | 'paeds.givenBeforeBirth'
  | 'paeds.givenInFuture'
  | 'paeds.batchExpired'
  | 'paeds.timingWarning'
  | 'paeds.doseNotFound'
  | 'paeds.growthNotFound'
  | 'paeds.measuredRange'
  | 'paeds.ruleNotFound'
  | 'paeds.encounterMismatch'
  | 'paeds.notInSchedule';

/** Input / state errors the router turns into i18n keys (docs/02 §7). */
export class PaedsInputError extends Error {
  constructor(
    readonly key: PaedsErrorKey,
    /** For `paeds.timingWarning`: the warnings the person has to confirm. */
    readonly details: readonly DoseTimingProblem[] = [],
  ) {
    super(key);
    this.name = 'PaedsInputError';
  }
}

export interface PaedsActor {
  facilityId: string;
  userId: string;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const str = (n: number | null): string | null => (n === null ? null : String(n));
const plusDays = (d: string, n: number) => toIsoDate(addDays(parseIsoDate(d), n));

/** The IAP / UIP choice of the setting; used when the child has no profile row. */
type ScheduleName = ImmunisationScheduleName;

// ---------------------------------------------------------------- schedule master

const rowToItem = (r: typeof immunisationSchedule.$inferSelect): ScheduleItem => ({
  scheduleName: r.scheduleName as ScheduleName,
  vaccineCode: r.vaccineCode,
  doseNo: r.doseNo,
  label: r.label,
  labelHi: r.labelHi,
  dueAgeDays: r.dueAgeDays,
  minAgeDays: r.minAgeDays,
  maxAgeDays: r.maxAgeDays,
  minIntervalDays: r.minIntervalDays,
  isOptional: r.isOptional,
  onlySex: r.onlySex as 'F' | 'M' | null,
});

/** Inserts the draft schedules of docs/33 §5 for doses the facility does not have yet (idempotent). */
export async function seedImmunisationSchedule(tx: Tx, facilityId: string): Promise<number> {
  const have = new Set(
    (
      await tx
        .select({
          n: immunisationSchedule.scheduleName,
          c: immunisationSchedule.vaccineCode,
          d: immunisationSchedule.doseNo,
        })
        .from(immunisationSchedule)
        .where(eq(immunisationSchedule.facilityId, facilityId))
    ).map((r) => `${r.n}/${r.c}/${r.d}`),
  );
  const all = Object.values(DEFAULT_IMMUNISATION_SCHEDULES).flat();
  const fresh = all.filter((i) => !have.has(`${i.scheduleName}/${i.vaccineCode}/${i.doseNo}`));
  if (fresh.length > 0) {
    await tx.insert(immunisationSchedule).values(
      fresh.map((i, n) => ({
        id: uuidv7(),
        facilityId,
        scheduleName: i.scheduleName,
        vaccineCode: i.vaccineCode,
        doseNo: i.doseNo,
        label: i.label,
        labelHi: i.labelHi,
        dueAgeDays: i.dueAgeDays,
        minAgeDays: i.minAgeDays,
        maxAgeDays: i.maxAgeDays,
        minIntervalDays: i.minIntervalDays,
        isOptional: i.isOptional,
        onlySex: i.onlySex,
        sortOrder: n,
      })),
    );
  }
  return fresh.length;
}

/** The facility's active schedule; the built-in draft until the master has been seeded. */
async function scheduleItems(
  q: Queryable,
  facilityId: string,
  name: ScheduleName,
): Promise<{ id: string | null; item: ScheduleItem }[]> {
  const rows = await q
    .select()
    .from(immunisationSchedule)
    .where(
      and(
        eq(immunisationSchedule.facilityId, facilityId),
        eq(immunisationSchedule.scheduleName, name),
        eq(immunisationSchedule.isActive, true),
      ),
    )
    .orderBy(asc(immunisationSchedule.sortOrder));
  return rows.length > 0
    ? rows.map((r) => ({ id: r.id, item: rowToItem(r) }))
    : DEFAULT_IMMUNISATION_SCHEDULES[name].map((item) => ({ id: null, item }));
}

// ---------------------------------------------------------------- rules in force

export interface PaedsRules {
  /** The paediatrician has reviewed and signed the schedule and rules off (`paeds.rulesSignedOff`). */
  signedOff: boolean;
  defaultSchedule: ScheduleName;
  overdueGraceDays: number;
  earlyGraceDays: number;
  reminderLeadDays: number;
}

export async function paedsRules(q: Queryable, facilityId: string): Promise<PaedsRules> {
  const s = await readSettings(q, facilityId, [
    'paeds.rulesSignedOff',
    'immunisation.defaultSchedule',
    'immunisation.overdueGraceDays',
    'immunisation.earlyGraceDays',
    'immunisation.reminderLeadDays',
  ]);
  return {
    signedOff: s['paeds.rulesSignedOff'],
    defaultSchedule: s['immunisation.defaultSchedule'],
    overdueGraceDays: s['immunisation.overdueGraceDays'],
    earlyGraceDays: s['immunisation.earlyGraceDays'],
    reminderLeadDays: s['immunisation.reminderLeadDays'],
  };
}

// ---------------------------------------------------------------- patient and shared lookups

interface ChildRow {
  id: string;
  uhid: string;
  fullName: string;
  nameHi: string | null;
  sex: 'F' | 'M' | 'O';
  dob: string;
  mobile: string | null;
  status: string;
}

async function loadPatient(q: Queryable, facilityId: string, patientId: string): Promise<ChildRow> {
  const [p] = await q
    .select({
      id: patient.id,
      uhid: patient.uhid,
      fullName: patient.fullName,
      nameHi: patient.nameHi,
      sex: patient.sex,
      dob: patient.dob,
      mobile: patient.mobile,
      status: patient.status,
    })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.facilityId, facilityId)));
  if (!p || p.status === 'cancelled') throw new PaedsInputError('paeds.patientNotFound');
  return p as ChildRow;
}

type GivenRow = typeof immunisationGiven.$inferSelect;

async function activeDoses(q: Queryable, facilityId: string, patientId: string) {
  return q
    .select()
    .from(immunisationGiven)
    .where(
      and(
        eq(immunisationGiven.facilityId, facilityId),
        eq(immunisationGiven.patientId, patientId),
        eq(immunisationGiven.status, 'active'),
      ),
    )
    .orderBy(asc(immunisationGiven.givenOn), asc(immunisationGiven.createdAt));
}

// ---------------------------------------------------------------- consent and the reminder

/** Latest WhatsApp consent decision: true / false, or null when nothing was ever recorded. */
export async function whatsappConsent(
  q: Queryable,
  facilityId: string,
  patientId: string,
): Promise<boolean | null> {
  const [c] = await q
    .select({ granted: patientConsent.granted })
    .from(patientConsent)
    .where(
      and(
        eq(patientConsent.facilityId, facilityId),
        eq(patientConsent.patientId, patientId),
        eq(patientConsent.kind, 'whatsapp'),
      ),
    )
    .orderBy(desc(patientConsent.at), desc(patientConsent.id))
    .limit(1);
  return c ? c.granted : null;
}

export interface QueuedReminder {
  id: string;
  dueDate: string;
  sendAfter: Date;
  vaccines: string[];
}

const VACCINE_REMINDER = 'vaccine_reminder';

async function queuedReminders(
  q: Queryable,
  facilityId: string,
  patientId: string,
): Promise<QueuedReminder[]> {
  const rows = await q
    .select()
    .from(messageOutbox)
    .where(
      and(
        eq(messageOutbox.facilityId, facilityId),
        eq(messageOutbox.patientId, patientId),
        eq(messageOutbox.templateKind, VACCINE_REMINDER),
        eq(messageOutbox.status, 'queued'),
      ),
    )
    .orderBy(asc(messageOutbox.sendAfter));
  return rows.map((r) => {
    const v = r.variables as { dueDate: string; vaccines: string[] };
    return { id: r.id, dueDate: v.dueDate, sendAfter: r.sendAfter, vaccines: v.vaccines };
  });
}

export interface ReminderOutcome {
  /** Queued (or already queued) for this due date. */
  queued: QueuedReminder | null;
  /** Why nothing is queued: no consent, no mobile, nothing due, or the date is too near. */
  skipped: 'no_consent' | 'no_mobile' | 'nothing_due' | 'too_late' | null;
}

/**
 * Brings the child's queued vaccine reminder in line with the schedule (docs/11 §4.1, docs/21):
 * one message per next due date, listing every compulsory dose due that day, going out `lead` days
 * before at 10:00 IST (not in quiet hours). Anything queued for another date is cancelled. Needs
 * the WhatsApp consent on record and a mobile; the counter never waits for the internet (rule 11),
 * the worker's sender (MSG-01) delivers the queued rows later.
 */
export async function refreshVaccineReminder(
  tx: Tx,
  facilityId: string,
  p: ChildRow,
  rows: readonly ScheduleRow[],
  lead: number,
  now: Date,
): Promise<ReminderOutcome> {
  const cancel = async (keepKey: string | null, reason: string) => {
    const open = await tx
      .select({ id: messageOutbox.id, key: messageOutbox.dedupeKey })
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.facilityId, facilityId),
          eq(messageOutbox.patientId, p.id),
          eq(messageOutbox.templateKind, VACCINE_REMINDER),
          eq(messageOutbox.status, 'queued'),
        ),
      );
    const stale = open.filter((o) => o.key !== keepKey).map((o) => o.id);
    if (stale.length > 0) {
      await tx
        .update(messageOutbox)
        .set({ status: 'cancelled', cancelReason: reason })
        .where(inArray(messageOutbox.id, stale));
    }
  };
  const next = nextDueDate(rows);
  if (next === null) {
    await cancel(null, 'nothing_due');
    return { queued: null, skipped: 'nothing_due' };
  }
  const consent = await whatsappConsent(tx, facilityId, p.id);
  if (consent !== true) {
    await cancel(null, 'no_consent');
    return { queued: null, skipped: 'no_consent' };
  }
  if (!p.mobile) {
    await cancel(null, 'no_mobile');
    return { queued: null, skipped: 'no_mobile' };
  }
  const sendAt = reminderSendAt(next, lead, now);
  if (sendAt === null) {
    await cancel(null, 'too_late');
    return { queued: null, skipped: 'too_late' };
  }
  const key = `${VACCINE_REMINDER}:${p.id}:${next}`;
  await cancel(key, 'schedule_changed');
  const doses = dosesDueOn(rows, next);
  const variables = {
    childName: p.fullName,
    dueDate: next,
    dueDateText: formatDate(next),
    vaccines: doses.map((d) => d.item.label),
    vaccinesHi: doses.map((d) => d.item.labelHi),
  };
  const [existing] = await tx
    .select({ id: messageOutbox.id })
    .from(messageOutbox)
    .where(
      and(
        eq(messageOutbox.facilityId, facilityId),
        eq(messageOutbox.dedupeKey, key),
        eq(messageOutbox.status, 'queued'),
      ),
    );
  if (existing) {
    // Same date, but the list of doses or the mobile may have changed.
    await tx
      .update(messageOutbox)
      .set({ variables, toMobile: p.mobile, sendAfter: sendAt })
      .where(eq(messageOutbox.id, existing.id));
  } else {
    await tx.insert(messageOutbox).values({
      id: uuidv7(),
      facilityId,
      patientId: p.id,
      channel: 'whatsapp',
      templateKind: VACCINE_REMINDER,
      toMobile: p.mobile,
      language: 'hi',
      variables,
      dedupeKey: key,
      sendAfter: sendAt,
    });
  }
  const queued = (await queuedReminders(tx, facilityId, p.id))[0] ?? null;
  return { queued, skipped: null };
}

async function assertEncounter(
  q: Queryable,
  facilityId: string,
  patientId: string,
  encounterId: string,
): Promise<void> {
  const [e] = await q
    .select({ id: encounter.id })
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.facilityId, facilityId),
        eq(encounter.patientId, patientId),
      ),
    );
  if (!e) throw new PaedsInputError('paeds.encounterMismatch');
}

// ---------------------------------------------------------------- the immunisation card

export interface GivenView {
  id: string;
  itemCode: string | null;
  vaccineName: string;
  brand: string | null;
  batchNo: string;
  expiry: string;
  site: string;
  route: string;
  givenOn: string;
  givenBy: string;
  nextDueDate: string | null;
  warnings: string[];
}

const toGiven = (r: GivenRow): GivenView => ({
  id: r.id,
  itemCode: r.itemCode,
  vaccineName: r.vaccineName,
  brand: r.brand,
  batchNo: r.batchNo,
  expiry: r.expiry,
  site: r.site,
  route: r.route,
  givenOn: r.givenOn,
  givenBy: r.givenBy,
  nextDueDate: r.nextDueDate,
  warnings: r.warnings,
});

export interface ChildHeader {
  id: string;
  uhid: string;
  name: string;
  nameHi: string | null;
  sex: 'F' | 'M' | 'O';
  dob: string;
  ageDays: number;
  mobile: string | null;
}

const header = (p: ChildRow, today: string): ChildHeader => ({
  id: p.id,
  uhid: p.uhid,
  name: p.fullName,
  nameHi: p.nameHi,
  sex: p.sex,
  dob: p.dob,
  ageDays: Math.max(daysBetween(parseIsoDate(p.dob), parseIsoDate(today)), 0),
  mobile: p.mobile,
});

export interface ImmunisationCard {
  patient: ChildHeader;
  rules: PaedsRules;
  scheduleName: ScheduleName;
  /** True when a profile row chose it, false when it is the facility default. */
  scheduleChosen: boolean;
  rows: ScheduleRow[];
  given: GivenView[];
  nextDueDate: string | null;
  whatsappConsent: boolean | null;
  reminders: QueuedReminder[];
}

async function buildCard(
  q: Queryable,
  facilityId: string,
  p: ChildRow,
  now: Date,
): Promise<ImmunisationCard> {
  const today = istDateString(now);
  const rules = await paedsRules(q, facilityId);
  const [prof] = await q
    .select({ n: immunisationProfile.scheduleName })
    .from(immunisationProfile)
    .where(
      and(eq(immunisationProfile.facilityId, facilityId), eq(immunisationProfile.patientId, p.id)),
    );
  const scheduleName = (prof?.n as ScheduleName | undefined) ?? rules.defaultSchedule;
  const [items, doses, consent, reminders] = await Promise.all([
    scheduleItems(q, facilityId, scheduleName),
    activeDoses(q, facilityId, p.id),
    whatsappConsent(q, facilityId, p.id),
    queuedReminders(q, facilityId, p.id),
  ]);
  const rows = computeImmunisationSchedule({
    dob: p.dob,
    sex: p.sex,
    today,
    items: items.map((i) => i.item),
    given: doses.map((d) => ({ id: d.id, itemCode: d.itemCode, givenOn: d.givenOn })),
    overdueGraceDays: rules.overdueGraceDays,
    earlyGraceDays: rules.earlyGraceDays,
  });
  return {
    patient: header(p, today),
    rules,
    scheduleName,
    scheduleChosen: !!prof,
    rows,
    given: doses.map(toGiven),
    nextDueDate: nextDueDate(rows),
    whatsappConsent: consent,
    reminders,
  };
}

export async function getImmunisationCard(
  q: Queryable,
  actor: PaedsActor,
  patientId: string,
  now: Date,
): Promise<ImmunisationCard> {
  const p = await loadPatient(q, actor.facilityId, patientId);
  return buildCard(q, actor.facilityId, p, now);
}

/** Batches recorded before for a vaccine, newest first: a quick pick until pharmacy stock exists (Phase 2A). */
export async function recentBatches(
  q: Queryable,
  facilityId: string,
  vaccineName: string,
  today: string,
): Promise<{ batchNo: string; expiry: string; brand: string | null }[]> {
  const rows = await q
    .select({
      batchNo: immunisationGiven.batchNo,
      expiry: immunisationGiven.expiry,
      brand: immunisationGiven.brand,
    })
    .from(immunisationGiven)
    .where(
      and(
        eq(immunisationGiven.facilityId, facilityId),
        eq(immunisationGiven.vaccineName, vaccineName),
        eq(immunisationGiven.status, 'active'),
        gte(immunisationGiven.expiry, today),
      ),
    )
    .orderBy(desc(immunisationGiven.givenOn), desc(immunisationGiven.createdAt))
    .limit(30);
  const seen = new Set<string>();
  const out: { batchNo: string; expiry: string; brand: string | null }[] = [];
  for (const r of rows) {
    const k = `${r.batchNo}/${r.expiry}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
    if (out.length >= 5) break;
  }
  return out;
}

export interface DoseCheck {
  blocking: DoseTimingProblem[];
  warnings: DoseTimingProblem[];
}

/** What recording a dose today would raise; saves nothing (drives the dialog). */
export async function checkDose(
  q: Queryable,
  actor: PaedsActor,
  o: { patientId: string; itemCode: string | null; givenOn: string },
  now: Date,
): Promise<DoseCheck> {
  const card = await getImmunisationCard(q, actor, o.patientId, now);
  return checkDoseTiming({
    dob: card.patient.dob,
    today: istDateString(now),
    givenOn: o.givenOn,
    rows: card.rows,
    itemCode: o.itemCode,
    earlyGraceDays: card.rules.earlyGraceDays,
  });
}

export interface RecordDoseResult {
  givenId: string;
  nextDueDate: string | null;
  reminder: ReminderOutcome;
}

const BLOCKING_KEYS: Partial<Record<DoseTimingProblem, PaedsErrorKey>> = {
  before_birth: 'paeds.givenBeforeBirth',
  future_date: 'paeds.givenInFuture',
  already_given: 'paeds.doseAlreadyGiven',
  not_in_schedule: 'paeds.notInSchedule',
};

/**
 * Records a dose given, with its batch and expiry. Timing problems that need a person's eye (too
 * early, after the maximum age, an earlier dose missing) are returned as `paeds.timingWarning`
 * until `confirmWarnings` is set; a date before birth or in the future, a dose already recorded
 * and an expired batch are always refused. Afterwards the next due date is worked out (catch-up
 * from the date actually given) and the reminder is queued when the family agreed.
 */
export async function recordDose(
  tx: Tx,
  actor: PaedsActor,
  input: RecordDoseInput,
  now: Date,
): Promise<RecordDoseResult> {
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'paeds.recordDose',
      key: input.idempotencyKey,
      payload: { ...input, idempotencyKey: undefined },
    },
    async () => {
      const f = actor.facilityId;
      const today = istDateString(now);
      // Locking the child serialises two desks giving the same dose.
      const [locked] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(and(eq(patient.id, input.patientId), eq(patient.facilityId, f)))
        .for('update');
      if (!locked) throw new PaedsInputError('paeds.patientNotFound');
      const p = await loadPatient(tx, f, input.patientId);
      const card = await buildCard(tx, f, p, now);

      const timing = checkDoseTiming({
        dob: p.dob,
        today,
        givenOn: input.givenOn,
        rows: card.rows,
        itemCode: input.itemCode,
        earlyGraceDays: card.rules.earlyGraceDays,
      });
      for (const b of timing.blocking) {
        const key = BLOCKING_KEYS[b];
        if (key) throw new PaedsInputError(key);
      }
      if (input.expiry < input.givenOn) throw new PaedsInputError('paeds.batchExpired');
      if (timing.warnings.length > 0 && !input.confirmWarnings) {
        throw new PaedsInputError('paeds.timingWarning', timing.warnings);
      }
      if (input.encounterId) {
        await assertEncounter(tx, f, p.id, input.encounterId);
      }

      const items = await scheduleItems(tx, f, card.scheduleName);
      const scheduleItemId =
        items.find((i) => i.item && scheduleItemCode(i.item) === input.itemCode)?.id ?? null;
      const givenId = uuidv7();
      await tx.insert(immunisationGiven).values({
        id: givenId,
        facilityId: f,
        patientId: p.id,
        itemCode: input.itemCode,
        scheduleItemId,
        scheduleName: card.scheduleName,
        vaccineName: input.vaccineName,
        brand: input.brand,
        batchNo: input.batchNo,
        expiry: input.expiry,
        site: input.site,
        route: input.route,
        givenOn: input.givenOn,
        givenBy: actor.userId,
        encounterId: input.encounterId,
        warnings: [...timing.warnings],
      });

      // The schedule with this dose in it: next due date (catch-up from the date given) + reminder.
      const after = await buildCard(tx, f, p, now);
      await tx
        .update(immunisationGiven)
        .set({ nextDueDate: after.nextDueDate })
        .where(eq(immunisationGiven.id, givenId));
      const reminder = await refreshVaccineReminder(
        tx,
        f,
        p,
        after.rows,
        card.rules.reminderLeadDays,
        now,
      );
      return { givenId, nextDueDate: after.nextDueDate, reminder };
    },
  );
}

/** Cancels a dose entered by mistake (kept on record with the reason); the schedule is recomputed. */
export async function cancelDose(
  tx: Tx,
  actor: PaedsActor,
  input: { id: string; reason: string },
  now: Date,
): Promise<{ nextDueDate: string | null; reminder: ReminderOutcome }> {
  const f = actor.facilityId;
  const [row] = await tx
    .select()
    .from(immunisationGiven)
    .where(and(eq(immunisationGiven.id, input.id), eq(immunisationGiven.facilityId, f)))
    .for('update');
  if (!row || row.status !== 'active') throw new PaedsInputError('paeds.doseNotFound');
  await tx
    .update(immunisationGiven)
    .set({
      status: 'cancelled',
      cancelReason: input.reason,
      cancelledBy: actor.userId,
      cancelledAt: now,
    })
    .where(eq(immunisationGiven.id, row.id));
  const p = await loadPatient(tx, f, row.patientId);
  const card = await buildCard(tx, f, p, now);
  const reminder = await refreshVaccineReminder(
    tx,
    f,
    p,
    card.rows,
    card.rules.reminderLeadDays,
    now,
  );
  return { nextDueDate: card.nextDueDate, reminder };
}

/** Switches one child between the IAP and UIP schedules. */
export async function setImmunisationSchedule(
  tx: Tx,
  actor: PaedsActor,
  input: { patientId: string; scheduleName: ScheduleName },
  now: Date,
): Promise<ReminderOutcome> {
  const f = actor.facilityId;
  const p = await loadPatient(tx, f, input.patientId);
  await tx.select({ id: patient.id }).from(patient).where(eq(patient.id, p.id)).for('update');
  const [existing] = await tx
    .select({ id: immunisationProfile.id })
    .from(immunisationProfile)
    .where(and(eq(immunisationProfile.facilityId, f), eq(immunisationProfile.patientId, p.id)));
  if (existing) {
    await tx
      .update(immunisationProfile)
      .set({ scheduleName: input.scheduleName })
      .where(eq(immunisationProfile.id, existing.id));
  } else {
    await tx.insert(immunisationProfile).values({
      id: uuidv7(),
      facilityId: f,
      patientId: p.id,
      scheduleName: input.scheduleName,
    });
  }
  const card = await buildCard(tx, f, p, now);
  return refreshVaccineReminder(tx, f, p, card.rows, card.rules.reminderLeadDays, now);
}

/** Records the family's WhatsApp decision (verbal, noted by staff) and updates the reminder. */
export async function setWhatsappConsent(
  tx: Tx,
  actor: PaedsActor,
  input: { patientId: string; granted: boolean },
  now: Date,
): Promise<ReminderOutcome> {
  const f = actor.facilityId;
  const p = await loadPatient(tx, f, input.patientId);
  await tx.insert(patientConsent).values({
    id: uuidv7(),
    facilityId: f,
    patientId: p.id,
    kind: 'whatsapp',
    granted: input.granted,
    at: now,
    capturedBy: actor.userId,
    method: 'verbal_recorded',
  });
  const card = await buildCard(tx, f, p, now);
  return refreshVaccineReminder(tx, f, p, card.rows, card.rules.reminderLeadDays, now);
}

export interface DueSoonItem {
  patientId: string;
  uhid: string;
  name: string;
  dob: string;
  mobile: string | null;
  nextDueDate: string;
  daysFromToday: number;
}

/**
 * Children whose last recorded dose left a next due date from `lookBackDays` ago to `aheadDays`
 * ahead (the desk list). Newborns never given a dose are not listed: they start from the birth
 * doses at the newborn record.
 */
export async function dueSoon(
  q: Queryable,
  facilityId: string,
  now: Date,
  o: { lookBackDays?: number; aheadDays?: number; limit?: number } = {},
): Promise<DueSoonItem[]> {
  const today = istDateString(now);
  const from = plusDays(today, -(o.lookBackDays ?? 60));
  const to = plusDays(today, o.aheadDays ?? 14);
  const latest = q
    .selectDistinctOn([immunisationGiven.patientId], {
      patientId: immunisationGiven.patientId,
      nextDueDate: immunisationGiven.nextDueDate,
    })
    .from(immunisationGiven)
    .where(
      and(eq(immunisationGiven.facilityId, facilityId), eq(immunisationGiven.status, 'active')),
    )
    .orderBy(
      immunisationGiven.patientId,
      desc(immunisationGiven.givenOn),
      desc(immunisationGiven.createdAt),
    )
    .as('latest');
  const rows = await q
    .select({
      patientId: patient.id,
      uhid: patient.uhid,
      name: patient.fullName,
      dob: patient.dob,
      mobile: patient.mobile,
      nextDueDate: latest.nextDueDate,
    })
    .from(latest)
    .innerJoin(patient, eq(patient.id, latest.patientId))
    .where(
      and(
        gte(latest.nextDueDate, from),
        lte(latest.nextDueDate, to),
        ne(patient.status, 'cancelled'),
      ),
    )
    .orderBy(asc(latest.nextDueDate), asc(patient.fullName))
    .limit(o.limit ?? 200);
  return rows.map((r) => ({
    patientId: r.patientId,
    uhid: r.uhid,
    name: r.name,
    dob: r.dob,
    mobile: r.mobile,
    nextDueDate: r.nextDueDate!,
    daysFromToday: daysBetween(parseIsoDate(today), parseIsoDate(r.nextDueDate!)),
  }));
}

// ---------------------------------------------------------------- growth

export interface GrowthView {
  id: string;
  measuredOn: string;
  ageDays: number;
  weightKg: number | null;
  lengthHeightCm: number | null;
  headCircCm: number | null;
  zScores: StoredZScores;
  bands: Partial<Record<GrowthIndicator, ZBand>>;
  source: string;
}

const toGrowth = (r: typeof growthMeasurement.$inferSelect): GrowthView => {
  const z = r.zScores as StoredZScores;
  const bands: Partial<Record<GrowthIndicator, ZBand>> = {};
  for (const k of ['wfa', 'lhfa', 'hcfa', 'wfh'] as const) {
    const v = z[k];
    if (typeof v === 'number') bands[k] = zBand(v);
  }
  return {
    id: r.id,
    measuredOn: r.measuredOn,
    ageDays: r.ageDays,
    weightKg: num(r.weightKg),
    lengthHeightCm: num(r.lengthHeightCm),
    headCircCm: num(r.headCircCm),
    zScores: z,
    bands,
    source: r.source,
  };
};

export interface ChartPoint {
  x: number;
  y: number;
  z: number | null;
  on: string;
}
export interface GrowthChart {
  indicator: GrowthIndicator;
  curve: GrowthCurve;
  points: ChartPoint[];
}

export interface GrowthOverview {
  patient: ChildHeader;
  rules: PaedsRules;
  measurements: GrowthView[];
  /** Null when the child is 5 years or older, or the sex is not M / F (values only). */
  charts: GrowthChart[] | null;
  chartsSkipped: 'age' | 'sex' | null;
}

function buildCharts(
  p: ChildRow,
  list: readonly GrowthView[],
  today: string,
): {
  charts: GrowthChart[] | null;
  skipped: 'age' | 'sex' | null;
} {
  const ageDays = daysBetween(parseIsoDate(p.dob), parseIsoDate(today));
  if (p.sex !== 'M' && p.sex !== 'F') return { charts: null, skipped: 'sex' };
  if (ageDays > WHO_MAX_AGE_DAYS) return { charts: null, skipped: 'age' };
  const charts: GrowthChart[] = [];
  const asc = [...list].sort((a, b) => a.measuredOn.localeCompare(b.measuredOn));
  const wfhPoints = asc.filter((m) => m.weightKg !== null && m.lengthHeightCm !== null);
  for (const ind of ['wfa', 'lhfa', 'hcfa', 'wfh'] as const) {
    const value = (m: GrowthView) =>
      ind === 'wfa'
        ? m.weightKg
        : ind === 'lhfa'
          ? m.lengthHeightCm
          : ind === 'hcfa'
            ? m.headCircCm
            : m.weightKg;
    const source = ind === 'wfh' ? wfhPoints : asc;
    // Weight-for-height uses the length table below 2 y and the height table after; plot the
    // side the child is on now.
    const onLength = ageDays < WHO_LENGTH_UNTIL_DAYS;
    const points = source
      .filter((m) => value(m) !== null && m.ageDays <= WHO_MAX_AGE_DAYS)
      .filter((m) => ind !== 'wfh' || m.ageDays < WHO_LENGTH_UNTIL_DAYS === onLength)
      .map((m) => ({
        x: ind === 'wfh' ? m.lengthHeightCm! : m.ageDays,
        y: value(m)!,
        z: m.zScores[ind],
        on: m.measuredOn,
      }));
    charts.push({
      indicator: ind,
      curve: growthCurve({ indicator: ind, sex: p.sex, ageDays, stepDays: 15 }),
      points,
    });
  }
  return { charts, skipped: null };
}

export async function getGrowthOverview(
  q: Queryable,
  actor: PaedsActor,
  patientId: string,
  now: Date,
): Promise<GrowthOverview> {
  const f = actor.facilityId;
  const p = await loadPatient(q, f, patientId);
  const today = istDateString(now);
  const rows = await q
    .select()
    .from(growthMeasurement)
    .where(
      and(
        eq(growthMeasurement.facilityId, f),
        eq(growthMeasurement.patientId, p.id),
        eq(growthMeasurement.status, 'active'),
      ),
    )
    .orderBy(desc(growthMeasurement.measuredOn));
  const measurements = rows.map(toGrowth);
  const { charts, skipped } = buildCharts(p, measurements, today);
  return {
    patient: header(p, today),
    rules: await paedsRules(q, f),
    measurements,
    charts,
    chartsSkipped: skipped,
  };
}

interface MeasureValues {
  weightKg: number | null;
  lengthHeightCm: number | null;
  headCircCm: number | null;
}

/** Inserts the day's measurement, replacing (cancelling) the one it corrects. */
async function putMeasurement(
  tx: Tx,
  actor: PaedsActor,
  p: ChildRow,
  o: MeasureValues & {
    measuredOn: string;
    encounterId: string | null;
    source: 'vitals' | 'paeds';
  },
  now: Date,
): Promise<{ id: string; zScores: StoredZScores }> {
  const f = actor.facilityId;
  const zScores = computeZScores({
    sex: p.sex,
    dob: p.dob,
    measuredOn: o.measuredOn,
    weightKg: o.weightKg,
    lengthHeightCm: o.lengthHeightCm,
    headCircCm: o.headCircCm,
  });
  const [old] = await tx
    .select({ id: growthMeasurement.id })
    .from(growthMeasurement)
    .where(
      and(
        eq(growthMeasurement.patientId, p.id),
        eq(growthMeasurement.measuredOn, o.measuredOn),
        eq(growthMeasurement.status, 'active'),
      ),
    )
    .for('update');
  if (old) {
    await tx
      .update(growthMeasurement)
      .set({
        status: 'cancelled',
        cancelReason: 'replaced by a new measurement',
        cancelledBy: actor.userId,
        cancelledAt: now,
      })
      .where(eq(growthMeasurement.id, old.id));
  }
  const id = uuidv7();
  await tx.insert(growthMeasurement).values({
    id,
    facilityId: f,
    patientId: p.id,
    encounterId: o.encounterId,
    measuredOn: o.measuredOn,
    ageDays: daysBetween(parseIsoDate(p.dob), parseIsoDate(o.measuredOn)),
    weightKg: str(o.weightKg),
    lengthHeightCm: str(o.lengthHeightCm),
    headCircCm: str(o.headCircCm),
    zScores,
    source: o.source,
  });
  return { id, zScores };
}

export async function recordGrowth(
  tx: Tx,
  actor: PaedsActor,
  input: RecordGrowthInput,
  now: Date,
): Promise<{ id: string; zScores: StoredZScores }> {
  return runIdempotent(
    tx,
    {
      facilityId: actor.facilityId,
      userId: actor.userId,
      procedure: 'paeds.recordGrowth',
      key: input.idempotencyKey,
      payload: { ...input, idempotencyKey: undefined },
    },
    async () => {
      const f = actor.facilityId;
      const p = await loadPatient(tx, f, input.patientId);
      if (input.measuredOn < p.dob || input.measuredOn > istDateString(now)) {
        throw new PaedsInputError('paeds.measuredRange');
      }
      if (input.encounterId) {
        await assertEncounter(tx, f, p.id, input.encounterId);
      }
      return putMeasurement(
        tx,
        actor,
        p,
        {
          measuredOn: input.measuredOn,
          weightKg: input.weightKg,
          lengthHeightCm: input.lengthHeightCm,
          headCircCm: input.headCircCm,
          encounterId: input.encounterId,
          source: 'paeds',
        },
        now,
      );
    },
  );
}

export async function cancelGrowth(
  tx: Tx,
  actor: PaedsActor,
  input: { id: string; reason: string },
  now: Date,
): Promise<void> {
  const [row] = await tx
    .select({ id: growthMeasurement.id, status: growthMeasurement.status })
    .from(growthMeasurement)
    .where(
      and(eq(growthMeasurement.id, input.id), eq(growthMeasurement.facilityId, actor.facilityId)),
    )
    .for('update');
  if (!row || row.status !== 'active') throw new PaedsInputError('paeds.growthNotFound');
  await tx
    .update(growthMeasurement)
    .set({
      status: 'cancelled',
      cancelReason: input.reason,
      cancelledBy: actor.userId,
      cancelledAt: now,
    })
    .where(eq(growthMeasurement.id, row.id));
}

/**
 * A child's vitals (weight, length / height, head circumference) also fill that day's growth
 * measurement (docs/11 §4.2), unless a person already entered the day on the paediatrics screen.
 */
export async function syncGrowthFromVitals(
  tx: Tx,
  actor: PaedsActor,
  o: MeasureValues & { patientId: string; encounterId: string; measuredOn: string },
  now: Date,
): Promise<void> {
  if (o.weightKg === null && o.lengthHeightCm === null && o.headCircCm === null) return;
  const p = await loadPatient(tx, actor.facilityId, o.patientId);
  if (o.measuredOn < p.dob) return;
  const [same] = await tx
    .select({ source: growthMeasurement.source })
    .from(growthMeasurement)
    .where(
      and(
        eq(growthMeasurement.patientId, p.id),
        eq(growthMeasurement.measuredOn, o.measuredOn),
        eq(growthMeasurement.status, 'active'),
      ),
    );
  if (same && same.source === 'paeds') return;
  await putMeasurement(tx, actor, p, { ...o, source: 'vitals' }, now);
}

// ---------------------------------------------------------------- weight-based dose rules (§4.4)

type RuleRow = typeof drugPaedsRule.$inferSelect;

const toRule = (r: RuleRow): PaedsDoseRule => ({
  genericName: r.genericName,
  mgPerKgMin: Number(r.mgPerKgMin),
  mgPerKgMax: Number(r.mgPerKgMax),
  maxMgPerDose: num(r.maxMgPerDose),
  maxDosesPerDay: r.maxDosesPerDay,
  concentrationMgPerMl: r.concentrationMgPerMl,
});

export interface PaedsRuleView extends PaedsDoseRule {
  id: string;
  note: string | null;
  approvedBy: string | null;
  approvedOn: string | null;
}

export async function listPaedsRules(q: Queryable, facilityId: string): Promise<PaedsRuleView[]> {
  const rows = await q
    .select()
    .from(drugPaedsRule)
    .where(
      and(
        eq(drugPaedsRule.facilityId, facilityId),
        eq(drugPaedsRule.status, 'active'),
        eq(drugPaedsRule.isActive, true),
      ),
    )
    .orderBy(asc(drugPaedsRule.genericName));
  return rows.map((r) => ({
    ...toRule(r),
    id: r.id,
    note: r.note,
    approvedBy: r.approvedBy,
    approvedOn: r.approvedOn,
  }));
}

/**
 * Stores a rule the paediatrician approved. An existing rule for the same generic is replaced by
 * cancelling it (the old values stay on record) and inserting the new one. There is no seed:
 * rules exist only when the hospital enters them (docs/11 §4.4).
 */
export async function upsertPaedsRule(
  tx: Tx,
  actor: PaedsActor,
  input: PaedsRuleInput & { approvedBy: string | null; approvedOn: string | null },
  now: Date,
): Promise<{ id: string }> {
  const f = actor.facilityId;
  const generic = input.genericName.trim().toLowerCase();
  const [old] = await tx
    .select({ id: drugPaedsRule.id })
    .from(drugPaedsRule)
    .where(
      and(
        eq(drugPaedsRule.facilityId, f),
        eq(drugPaedsRule.genericName, generic),
        eq(drugPaedsRule.status, 'active'),
      ),
    )
    .for('update');
  if (old) {
    await tx
      .update(drugPaedsRule)
      .set({
        status: 'cancelled',
        cancelReason: 'replaced by a new version',
        cancelledBy: actor.userId,
        cancelledAt: now,
      })
      .where(eq(drugPaedsRule.id, old.id));
  }
  const id = uuidv7();
  await tx.insert(drugPaedsRule).values({
    id,
    facilityId: f,
    genericName: generic,
    mgPerKgMin: String(input.mgPerKgMin),
    mgPerKgMax: String(input.mgPerKgMax),
    maxMgPerDose: str(input.maxMgPerDose),
    maxDosesPerDay: input.maxDosesPerDay,
    concentrationMgPerMl: Object.fromEntries(
      Object.entries(input.concentrationMgPerMl).filter(([, v]) => typeof v === 'number'),
    ) as Record<string, number>,
    note: input.note,
    approvedBy: input.approvedBy,
    approvedOn: input.approvedOn,
  });
  return { id };
}

export async function cancelPaedsRule(
  tx: Tx,
  actor: PaedsActor,
  input: { id: string; reason: string },
  now: Date,
): Promise<void> {
  const [row] = await tx
    .select({ id: drugPaedsRule.id, status: drugPaedsRule.status })
    .from(drugPaedsRule)
    .where(and(eq(drugPaedsRule.id, input.id), eq(drugPaedsRule.facilityId, actor.facilityId)))
    .for('update');
  if (!row || row.status !== 'active') throw new PaedsInputError('paeds.ruleNotFound');
  await tx
    .update(drugPaedsRule)
    .set({
      status: 'cancelled',
      cancelReason: input.reason,
      cancelledBy: actor.userId,
      cancelledAt: now,
    })
    .where(eq(drugPaedsRule.id, row.id));
}

/** What the Rx screen needs to check a child's doses (docs/11 §4.4). */
export interface PaedsRxContext {
  weightKg: number | null;
  /** The day the weight was measured; the check uses today's weight only. */
  weightOn: string | null;
  rules: PaedsDoseRule[];
}

const CHILD_YEARS = 18;

/**
 * Today's weight and the dose rules for a child under 18; null for an adult or when the hospital
 * has no rules (nothing to check, nothing to show).
 */
export async function paedsRxContext(
  q: Queryable,
  facilityId: string,
  patientId: string,
  now: Date,
): Promise<PaedsRxContext | null> {
  const [p] = await q
    .select({ dob: patient.dob })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.facilityId, facilityId)));
  if (!p) return null;
  const age = ageFromDob(p.dob, now);
  if (age.unit === 'years' && age.value >= CHILD_YEARS) return null;
  const rules = (
    await q
      .select()
      .from(drugPaedsRule)
      .where(
        and(
          eq(drugPaedsRule.facilityId, facilityId),
          eq(drugPaedsRule.status, 'active'),
          eq(drugPaedsRule.isActive, true),
        ),
      )
  ).map(toRule);
  if (rules.length === 0) return null;
  const today = istDateString(now);
  const [v] = await q
    .select({ w: vitals.weightKg, at: vitals.recordedAt })
    .from(vitals)
    .where(
      and(
        eq(vitals.facilityId, facilityId),
        eq(vitals.patientId, patientId),
        eq(vitals.status, 'active'),
        sql`${vitals.weightKg} is not null`,
        sql`(${vitals.recordedAt} at time zone 'Asia/Kolkata')::date = ${today}::date`,
      ),
    )
    .orderBy(desc(vitals.recordedAt))
    .limit(1);
  if (v?.w) return { weightKg: Number(v.w), weightOn: today, rules };
  const [g] = await q
    .select({ w: growthMeasurement.weightKg })
    .from(growthMeasurement)
    .where(
      and(
        eq(growthMeasurement.facilityId, facilityId),
        eq(growthMeasurement.patientId, patientId),
        eq(growthMeasurement.status, 'active'),
        eq(growthMeasurement.measuredOn, today),
        sql`${growthMeasurement.weightKg} is not null`,
      ),
    )
    .limit(1);
  return { weightKg: g?.w ? Number(g.w) : null, weightOn: g?.w ? today : null, rules };
}

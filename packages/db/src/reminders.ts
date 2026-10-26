/**
 * The 7 pm reminder run (MSG-01, docs/01 §2, docs/21 §3): looks at what is coming up and queues
 * the follow-up and ANC reminders for 10 am the next morning (vaccine reminders have their own
 * scheduling in `refreshVaccineReminder`). A reminder is queued for the day that is its lead time
 * before the visit, so the run at 7 pm of day D queues the visits of day D + 1 + lead, to go out at
 * 10:00 on D + 1: never in quiet hours. Idempotent: the outbox de-duplicates per entity.
 */
import {
  addDays,
  formatDate,
  istDateString,
  parseIsoDate,
  reminderInstant,
  toIsoDate,
} from '@hmis/shared';
import { and, eq, gte, lte } from 'drizzle-orm';
import { clinicalNote, doctorProfile, encounter, messageOutbox, patient } from '../schema';
import { activePregnancies } from './anc';
import type { Db } from './client';
import { enqueueMessage, activeFacilityIds } from './messaging';
import { refreshDueVaccineReminders } from './paeds';
import { readSettings } from './settings';
import { withTx } from './tx';

const plus = (date: string, days: number) => toIsoDate(addDays(parseIsoDate(date), days));
/** A visit already reminded within this long is not reminded again by the overlapping windows. */
const REMINDED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export interface ReminderRun {
  followUp: number;
  anc: number;
  vaccine: number;
}

export async function queueDailyReminders(
  db: Db,
  facilityId: string,
  now: Date,
): Promise<ReminderRun> {
  const cfg = await readSettings(db, facilityId, [
    'whatsapp.enabled',
    'whatsapp.followUpLeadDays',
    'whatsapp.ancLeadDays',
  ]);
  const out: ReminderRun = { followUp: 0, anc: 0, vaccine: 0 };
  if (!cfg['whatsapp.enabled']) return out;
  const tomorrow = plus(istDateString(now), 1);
  const sendAfter = reminderInstant(tomorrow);
  // Visits from tomorrow up to the normal target are in the window: a run that did not happen
  // (power cut, restart) leaves its visits to the next run, which sends at its own next 10:00.
  // Visits already today or past are not reminded.
  const followUpTarget = plus(tomorrow, cfg['whatsapp.followUpLeadDays']);
  const lookback = new Date(now.getTime() - REMINDED_LOOKBACK_MS);
  const alreadyReminded = async (patientId: string, kind: string, entityId: string) => {
    const [row] = await db
      .select({ id: messageOutbox.id })
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.facilityId, facilityId),
          eq(messageOutbox.patientId, patientId),
          eq(messageOutbox.templateKind, kind),
          eq(messageOutbox.entityId, entityId),
          gte(messageOutbox.createdAt, lookback),
        ),
      )
      .limit(1);
    return !!row;
  };

  const notes = await db
    .select({
      id: clinicalNote.id,
      patientId: clinicalNote.patientId,
      patientName: patient.fullName,
      date: clinicalNote.followUpDate,
      doctorName: doctorProfile.displayName,
    })
    .from(clinicalNote)
    .innerJoin(patient, eq(patient.id, clinicalNote.patientId))
    .innerJoin(encounter, eq(encounter.id, clinicalNote.encounterId))
    .leftJoin(doctorProfile, eq(doctorProfile.id, encounter.doctorId))
    .where(
      and(
        eq(clinicalNote.facilityId, facilityId),
        eq(clinicalNote.status, 'final'),
        gte(clinicalNote.followUpDate, tomorrow),
        lte(clinicalNote.followUpDate, followUpTarget),
      ),
    );
  for (const n of notes) {
    try {
      if (await alreadyReminded(n.patientId, 'follow_up', n.id)) continue;
      const r = await withTx({ db, userId: null, facilityId }, (tx) =>
        enqueueMessage(
          tx,
          {
            facilityId,
            patientId: n.patientId,
            kind: 'follow_up',
            entityId: n.id,
            sendAfter,
            variables: {
              patientName: n.patientName,
              doctorName: n.doctorName ?? '',
              date: formatDate(n.date!),
            },
          },
          now,
        ),
      );
      if (r.id) out.followUp += 1;
    } catch {
      // One bad row must not drop the rest of the run; the next run retries it (no patient data logged).
    }
  }

  const target = plus(tomorrow, cfg['whatsapp.ancLeadDays']);
  const pregnancies = await activePregnancies(
    db,
    { facilityId, userId: SYSTEM_USER, mtp: { view: false, edit: false } },
    now,
  );
  for (const p of pregnancies) {
    const date = p.nextVisit?.date;
    if (!date || date < tomorrow || date > target) continue;
    try {
      if (await alreadyReminded(p.patientId, 'anc_reminder', p.id)) continue;
      const r = await withTx({ db, userId: null, facilityId }, (tx) =>
        enqueueMessage(
          tx,
          {
            facilityId,
            patientId: p.patientId,
            kind: 'anc_reminder',
            entityId: p.id,
            sendAfter,
            variables: { patientName: p.fullName, date: formatDate(date) },
          },
          now,
        ),
      );
      if (r.id) out.anc += 1;
    } catch {
      // See above: isolate the failure to this pregnancy.
    }
  }

  out.vaccine = await refreshDueVaccineReminders(db, facilityId, now);
  return out;
}

/** The run for every active facility (the `reminder.daily` job). */
export async function queueDailyRemindersAll(
  db: Db,
  now: Date,
): Promise<Record<string, ReminderRun>> {
  const out: Record<string, ReminderRun> = {};
  for (const f of await activeFacilityIds(db)) out[f] = await queueDailyReminders(db, f, now);
  return out;
}

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
import { and, eq } from 'drizzle-orm';
import { clinicalNote, doctorProfile, encounter, patient } from '../schema';
import { activePregnancies } from './anc';
import type { Db } from './client';
import { enqueueMessage, activeFacilityIds } from './messaging';
import { refreshDueVaccineReminders } from './paeds';
import { readSettings } from './settings';
import { withTx } from './tx';

const plus = (date: string, days: number) => toIsoDate(addDays(parseIsoDate(date), days));
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
        eq(clinicalNote.followUpDate, plus(tomorrow, cfg['whatsapp.followUpLeadDays'])),
      ),
    );
  for (const n of notes) {
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
  }

  const target = plus(tomorrow, cfg['whatsapp.ancLeadDays']);
  const pregnancies = await activePregnancies(
    db,
    { facilityId, userId: SYSTEM_USER, mtp: { view: false, edit: false } },
    now,
  );
  for (const p of pregnancies) {
    if (p.nextVisit?.date !== target) continue;
    const r = await withTx({ db, userId: null, facilityId }, (tx) =>
      enqueueMessage(
        tx,
        {
          facilityId,
          patientId: p.patientId,
          kind: 'anc_reminder',
          entityId: p.id,
          sendAfter,
          variables: { patientName: p.fullName, date: formatDate(target) },
        },
        now,
      ),
    );
    if (r.id) out.anc += 1;
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

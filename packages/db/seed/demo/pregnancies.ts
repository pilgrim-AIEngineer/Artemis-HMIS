import {
  addDays,
  createPregnancySchema,
  istDateString,
  parseIsoDate,
  toIsoDate,
} from '@hmis/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { appUser, patient, pregnancy } from '../../schema';
import { createPregnancy, saveAncVisit, type AncActor } from '../../src/anc';
import type { DemoStep } from '.';
import { int, pick } from './rng';

export const DEMO_PREGNANCY_COUNT = 50;
const BLOOD_GROUPS = ['A+', 'B+', 'O+', 'AB+', 'O+', 'B+', 'A-', 'O-'] as const;

/**
 * 50 synthetic pregnancies (docs/02 §9) for married demo patients, each booked at 8–16 weeks and
 * followed by a 4-weekly ANC visit up to today, through `createPregnancy` / `saveAncVisit` so
 * EDD, GA, GPAL and risk flags are the real ones. A few have a raised BP (risk flag) and a few are
 * dated by scan only. Runs once.
 */
export const demoPregnancies: DemoStep = {
  name: 'pregnancies',
  async run({ tx, facilityId, rng }) {
    const [have] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(pregnancy)
      .where(eq(pregnancy.facilityId, facilityId));
    if ((have?.n ?? 0) >= DEMO_PREGNANCY_COUNT) return `${have!.n} already present`;

    const [user] = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.facilityId, facilityId))
      .limit(1);
    // Married adult women, born 18–40 years ago (`age` strings were resolved to an estimated DOB).
    const todayIso = istDateString(new Date());
    const oldest = toIsoDate(addDays(parseIsoDate(todayIso), -40 * 366));
    const youngest = toIsoDate(addDays(parseIsoDate(todayIso), -18 * 365));
    const women = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(
        and(
          eq(patient.facilityId, facilityId),
          eq(patient.status, 'active'),
          eq(patient.sex, 'F'),
          eq(patient.maritalStatus, 'married'),
          gte(patient.dob, oldest),
          sql`${patient.dob} <= ${youngest}`,
        ),
      )
      .orderBy(patient.uhid);
    if (!user || women.length === 0) return 'skipped (no users or married adult patients yet)';

    const actor: AncActor = {
      facilityId,
      userId: user.id,
      mtp: { view: false, edit: false },
    };
    const today = parseIsoDate(todayIso);
    const at = (iso: string) => new Date(`${iso}T10:00:00+05:30`);
    const pool = [...women];
    let made = 0;
    let visits = 0;
    while (made + (have?.n ?? 0) < DEMO_PREGNANCY_COUNT && pool.length > 0) {
      const woman = pool.splice(int(rng, 0, pool.length - 1), 1)[0]!;
      const gaTodayDays = int(rng, 14 * 7, 38 * 7);
      const bookingGaDays = Math.min(int(rng, 8 * 7, 16 * 7), gaTodayDays);
      const lmp = toIsoDate(addDays(today, -gaTodayDays));
      const bookingDate = toIsoDate(addDays(parseIsoDate(lmp), bookingGaDays));
      const scanOnly = rng() < 0.1 && bookingGaDays >= 10 * 7;
      const raised = rng() < 0.12;
      const { pregnancyId } = await createPregnancy(
        tx,
        actor,
        createPregnancySchema.parse({
          patientId: woman.id,
          idempotencyKey: uuidv7(),
          lmp: scanOnly ? null : lmp,
          scan: scanOnly
            ? { date: bookingDate, ga: { weeks: Math.floor(bookingGaDays / 7), days: 0 } }
            : null,
          bloodGroupRh: pick(rng, BLOOD_GROUPS),
        }),
        at(bookingDate),
      ).catch((e: unknown) => {
        // A date outside the allowed range for this woman is skipped; anything else is real.
        if (e instanceof Error && e.name === 'AncInputError') return { pregnancyId: null };
        throw e;
      });
      if (!pregnancyId) continue;
      made += 1;
      for (let d = bookingGaDays; d <= gaTodayDays; d += 28) {
        const visitDate = toIsoDate(addDays(parseIsoDate(lmp), d));
        if (visitDate > todayIso) break;
        const weeks = d / 7;
        const lateRaised = raised && d > 24 * 7;
        await saveAncVisit(
          tx,
          actor,
          {
            pregnancyId,
            encounterId: null,
            visitDate,
            weightKg: Math.round((52 + weeks * 0.35 + int(rng, -4, 4)) * 10) / 10,
            bpSys: lateRaised ? int(rng, 146, 160) : int(rng, 100, 124),
            bpDia: lateRaised ? int(rng, 96, 104) : int(rng, 64, 80),
            fundalHeightCm: weeks >= 20 ? Math.round(weeks) : null,
            fhr: weeks >= 12 ? int(rng, 126, 154) : null,
            presentation: null,
            oedema: null,
            urineProtein: null,
            urineSugar: null,
            hb: Math.round((11.8 - weeks * 0.03 + int(rng, -10, 10) / 10) * 10) / 10,
            remarks: null,
          },
          at(visitDate),
        );
        visits += 1;
      }
    }
    return `${made} added (${visits} ANC visits)`;
  },
};

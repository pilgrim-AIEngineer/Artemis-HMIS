import {
  addDays,
  daysBetween,
  istDateString,
  parseIsoDate,
  recordDoseSchema,
  recordGrowthSchema,
  toIsoDate,
} from '@hmis/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { appUser, growthMeasurement, patient } from '../../schema';
import { getImmunisationCard, recordDose, recordGrowth, type PaedsActor } from '../../src/paeds';
import type { DemoStep } from '.';
import { int } from './rng';

export const DEMO_CHILD_COUNT = 80;

/** Route and site by vaccine code; anything else is an intramuscular dose in the thigh. */
const ORAL = new Set(['OPV', 'ROTA']);

/**
 * 80 synthetic children under 6 (docs/02 §9) from the demo patients: the doses the schedule says
 * were due by today are recorded through `recordDose` (batch, expiry, next-due and reminder
 * logic are the real ones; the newest dose is left outstanding so "vaccine due" lists are not
 * empty) and one to three weight/height readings through `recordGrowth` (WHO z-scores). Runs once.
 */
export const demoChildren: DemoStep = {
  name: 'children',
  async run({ tx, facilityId, rng }) {
    const [have] = await tx
      .select({ n: sql<number>`count(distinct ${growthMeasurement.patientId})::int` })
      .from(growthMeasurement)
      .where(eq(growthMeasurement.facilityId, facilityId));
    if ((have?.n ?? 0) >= DEMO_CHILD_COUNT) return `${have!.n} already present`;

    const [user] = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.facilityId, facilityId))
      .limit(1);
    const todayIso = istDateString(new Date());
    const today = parseIsoDate(todayIso);
    const children = await tx
      .select({ id: patient.id, dob: patient.dob })
      .from(patient)
      .where(
        and(
          eq(patient.facilityId, facilityId),
          eq(patient.status, 'active'),
          gt(patient.dob, toIsoDate(addDays(today, -6 * 365))),
        ),
      )
      .orderBy(patient.uhid)
      .limit(DEMO_CHILD_COUNT);
    if (!user || children.length === 0) return 'skipped (no users or young patients yet)';

    const actor: PaedsActor = { facilityId, userId: user.id };
    const at = (iso: string) => new Date(`${iso}T11:00:00+05:30`);
    let doses = 0;
    let readings = 0;
    for (const child of children) {
      const dob = parseIsoDate(child.dob);
      const ageDays = daysBetween(dob, today);
      const batch = `DEMO${int(rng, 100, 999)}`;
      const expiry = toIsoDate(addDays(today, 365));

      const card = await getImmunisationCard(tx, actor, child.id, at(todayIso));
      const dueByNow = card.rows.filter(
        (r) => r.status !== 'not_applicable' && r.dueDate !== null && r.dueDate <= todayIso,
      );
      // Leave the last due dose outstanding for most children.
      const toGive = rng() < 0.75 ? dueByNow.slice(0, -1) : dueByNow;
      for (const row of toGive) {
        const givenOn = toIsoDate(
          addDays(parseIsoDate(row.dueDate!), row.item.dueAgeDays === 0 ? 0 : int(rng, 0, 5)),
        );
        if (givenOn > todayIso) continue;
        const oral = ORAL.has(row.item.vaccineCode);
        await recordDose(
          tx,
          actor,
          recordDoseSchema.parse({
            idempotencyKey: uuidv7(),
            patientId: child.id,
            itemCode: row.code,
            vaccineName: row.item.label,
            batchNo: batch,
            expiry,
            site: oral
              ? 'oral'
              : row.item.vaccineCode === 'BCG'
                ? 'intradermal_left_arm'
                : 'left_thigh',
            route: oral ? 'oral' : row.item.vaccineCode === 'BCG' ? 'id' : 'im',
            givenOn,
            confirmWarnings: true,
          }),
          at(givenOn),
        );
        doses += 1;
      }

      // Growth: a reading around each of up to three recent ages, near the WHO median.
      const marks = [ageDays, ageDays - int(rng, 60, 120), ageDays - int(rng, 150, 300)]
        .filter((d) => d >= 1)
        .slice(0, int(rng, 1, 3));
      for (const d of marks) {
        const months = d / 30.4;
        const weight = months <= 12 ? 3.4 + 0.55 * months : 10 + (months - 12) * 0.19;
        const length = months <= 12 ? 50 + 2.1 * months : 75 + (months - 12) * 0.47;
        const jitter = () => 1 + int(rng, -8, 8) / 100;
        await recordGrowth(
          tx,
          actor,
          recordGrowthSchema.parse({
            idempotencyKey: uuidv7(),
            patientId: child.id,
            measuredOn: toIsoDate(addDays(today, -(ageDays - d))),
            weightKg: weight * jitter(),
            lengthHeightCm: length * jitter(),
            headCircCm: null,
          }),
          at(todayIso),
        );
        readings += 1;
      }
    }
    return `${children.length} children (${doses} doses, ${readings} growth readings)`;
  },
};

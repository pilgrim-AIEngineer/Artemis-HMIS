import { addDays, istDateString, parseIsoDate, toIsoDate } from '@hmis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { consultationRule, encounter, patient } from '../../schema';
import { collectPayment } from '../../src/billing';
import { advanceToken } from '../../src/queue';
import { createVisit, issueToken, VisitInputError } from '../../src/visits';
import type { DemoStep } from '.';
import { int, pick } from './rng';

export const DEMO_OPD_DAYS = 30;
const VISITS_PER_DAY = [10, 18] as const;

/**
 * 30 days of synthetic OPD (docs/02 §9): a few visits a day per doctor with a fee rule, through
 * `createVisit`, so visit numbers, follow-up logic, fees and tokens are the real ones. Every
 * token is walked to `done` with plausible times. Runs once; the hospital's own data never gets
 * these (demo only). Fees are collected through `collectPayment` (BIL-02).
 */
export const demoOpd: DemoStep = {
  name: 'opd',
  async run({ tx, facilityId, rng }) {
    const [have] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(encounter)
      .where(eq(encounter.facilityId, facilityId));
    if ((have?.n ?? 0) > 0) return `${have!.n} visits already present`;

    const doctors = await tx
      .selectDistinct({ id: consultationRule.doctorId })
      .from(consultationRule)
      .where(
        and(eq(consultationRule.facilityId, facilityId), eq(consultationRule.status, 'active')),
      );
    const people = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.facilityId, facilityId), eq(patient.status, 'active')))
      .orderBy(patient.uhid)
      .limit(500);
    if (doctors.length === 0 || people.length === 0) return 'skipped (no doctors or patients yet)';

    const actor = { facilityId, userId: null };
    const today = parseIsoDate(istDateString(new Date()));
    let visits = 0;
    for (let back = DEMO_OPD_DAYS; back >= 1; back--) {
      const day = toIsoDate(addDays(today, -back));
      const n = int(rng, VISITS_PER_DAY[0], VISITS_PER_DAY[1]);
      const times = Array.from({ length: n }, () => int(rng, 9 * 60, 13 * 60 + 59)).sort(
        (a, b) => a - b,
      );
      for (const minute of times) {
        const at = (m: number) =>
          new Date(
            `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+05:30`,
          );
        const doctorId = pick(rng, doctors).id;
        const v = await createVisit(
          tx,
          actor,
          {
            patientId: pick(rng, people).id,
            doctorId,
            allowRepeatToday: true,
            idempotencyKey: uuidv7(),
          },
          at(minute),
        ).catch((e: unknown) => {
          // A refused visit (e.g. a deceased patient) is skipped; anything else is a real error.
          if (e instanceof VisitInputError) return null;
          throw e;
        });
        if (!v) continue;
        visits += 1;
        // The fee is paid at the counter (mostly cash, some UPI): the payment finalises the
        // bill and releases the token, as at the real desk. Unpriced visits get a manual token.
        if (!v.tokenId && BigInt(v.feePaise) > 0n) {
          await collectPayment(
            tx,
            actor,
            {
              billId: v.billId,
              tenders: [
                rng() < 0.3
                  ? { mode: 'upi', amountPaise: v.feePaise, upiRef: String(int(rng, 1000, 999999)) }
                  : { mode: 'cash', amountPaise: v.feePaise },
              ],
              idempotencyKey: uuidv7(),
            },
            at(minute + 1),
            { mayFinalize: true },
          );
        } else if (!v.tokenId) {
          await issueToken(tx, actor, v.encounterId, 'manual_fee_pending', at(minute));
        }
        const tokenId =
          v.tokenId ??
          (
            await tx.execute<{ id: string }>(
              sql`select id from opd_token where encounter_id = ${v.encounterId}`,
            )
          ).rows[0]!.id;
        const steps = [
          ['vitals_done', minute + int(rng, 2, 8)],
          ['with_doctor', minute + int(rng, 10, 40)],
          ['seen', minute + int(rng, 42, 60)],
          ['done', minute + int(rng, 62, 90)],
        ] as const;
        for (const [state, m] of steps) {
          await advanceToken(tx, actor, tokenId, state, at(m), 'demo');
        }
      }
    }
    return `${visits} visits over ${DEMO_OPD_DAYS} days`;
  },
};
